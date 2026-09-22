#!/usr/bin/env node

// MUST be first for the same libuv/thread-pool behavior as the stdio entrypoint.
import '../bootstrap.js';

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { DesktopCommanderIntegration } from '../remote-device/desktop-commander-integration.js';
import { VERSION } from '../version.js';
import {
  applySelfHostedEnvironment,
  isBearerAuthorized,
  requireBearerToken,
  resolveAuthMode,
  resolveListenHost,
  resolveListenPort,
} from './security.js';
import {
  SelfHostedOAuthServer,
  resolveOAuthConfig,
} from './oauth.js';

type RequestContext = {
  server: Server;
  transport: StreamableHTTPServerTransport;
  closing: boolean;
};

applySelfHostedEnvironment();

const authMode = resolveAuthMode();
const bearerToken =
  authMode === 'bearer' || authMode === 'both' ? requireBearerToken() : null;
const oauth =
  authMode === 'oauth' || authMode === 'both'
    ? new SelfHostedOAuthServer(resolveOAuthConfig())
    : null;
const host = resolveListenHost();
const port = resolveListenPort();
const desktop = new DesktopCommanderIntegration();
const activeRequests = new Set<RequestContext>();
let shuttingDown = false;

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }

  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendMcpError(
  res: http.ServerResponse,
  statusCode: number,
  code: number,
  message: string,
): void {
  sendJson(res, statusCode, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function authorize(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (
    bearerToken &&
    isBearerAuthorized(req.headers.authorization, bearerToken)
  ) {
    return true;
  }

  if (oauth?.authenticateBearer(req.headers.authorization)) {
    return true;
  }

  if (oauth) {
    res.setHeader('www-authenticate', oauth.challengeHeader());
  } else {
    res.setHeader('www-authenticate', 'Bearer realm="desktop-commander-mcp"');
  }
  sendMcpError(res, 401, -32001, 'Unauthorized');
  return false;
}

function addOAuthSecurityMetadata(tool: any): any {
  const securitySchemes = [{ type: 'oauth2', scopes: ['mcp:tools'] }];
  return {
    ...tool,
    securitySchemes,
    _meta: {
      ...(tool?._meta ?? {}),
      // Mirror the top-level field for ChatGPT clients that still read auth
      // metadata from _meta for backwards compatibility.
      securitySchemes,
    },
  };
}

/**
 * MCP SDK 1.x stateless HTTP pattern: create a fresh Server + transport for
 * every POST request and disable protocol session IDs. The shared local
 * Desktop Commander stdio client remains long-lived behind these lightweight
 * request-scoped MCP server instances.
 */
async function createRequestContext(): Promise<RequestContext> {
  const mcpServer = new Server(
    {
      name: 'desktop-commander-self-hosted',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    const result = await desktop.listClientTools();
    if (!oauth) return result;

    return {
      ...result,
      tools: (result.tools ?? []).map(addOAuthSecurityMetadata),
    } as any;
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    return (await desktop.callClientTool(toolName, args)) as any;
  });

  const transport = new StreamableHTTPServerTransport({
    // Explicitly disable MCP protocol sessions. ChatGPT may reconnect or send
    // stale Mcp-Session-Id headers; stateless mode ignores them.
    sessionIdGenerator: undefined,
    // Ordinary initialize/list/call traffic is request/response. Avoid
    // short-lived SSE streams through Cloudflare for every POST.
    enableJsonResponse: true,
  });

  const context: RequestContext = {
    server: mcpServer,
    transport,
    closing: false,
  };

  await mcpServer.connect(transport);
  return context;
}

async function closeRequestContext(context: RequestContext): Promise<void> {
  if (context.closing) return;
  context.closing = true;
  activeRequests.delete(context);

  try {
    await context.server.close();
  } catch (error) {
    console.error('[self-host] Failed to close stateless MCP request:', error);
  }
}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!authorize(req, res)) return;

  // This self-host server exposes only request/response tools. It does not use
  // server-initiated notifications, resumability, sampling, elicitation, or
  // any other feature that requires a standalone GET/SSE channel.
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendMcpError(
      res,
      405,
      -32000,
      'Method not allowed: stateless MCP endpoint accepts POST only',
    );
    return;
  }

  const context = await createRequestContext();
  activeRequests.add(context);

  try {
    await context.transport.handleRequest(req, res);
  } finally {
    await closeRequestContext(context);
  }
}

const httpServer = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'desktop-commander-self-hosted',
        version: VERSION,
        transport: 'streamable-http',
        transportMode: 'stateless-json',
        authMode,
        oauthIssuer: oauth?.config.issuer,
        activeMcpRequests: activeRequests.size,
        vendorRemoteServices: false,
      });
      return;
    }

    if (oauth?.canHandle(url.pathname)) {
      await oauth.handleHttp(req, res, url);
      return;
    }

    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    await handleMcpRequest(req, res);
  } catch (error) {
    console.error('[self-host] Request failed:', error);
    if (!res.headersSent) {
      sendMcpError(res, 500, -32603, 'Internal server error');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// Tool calls may intentionally run for many minutes. The local MCP proxy owns
// per-tool timeouts, so do not impose a shorter Node HTTP response timeout.
httpServer.requestTimeout = 0;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[self-host] ${signal} received; shutting down...`);

  const httpClosed = new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });

  // Close any request-scoped MCP transports still in flight before shutting
  // down the one shared local Desktop Commander stdio child.
  const requests = [...activeRequests];
  await Promise.allSettled(
    requests.map((context) => closeRequestContext(context)),
  );

  try {
    await desktop.shutdown();
  } catch (error) {
    console.error('[self-host] Failed to close Desktop Commander child:', error);
  }

  httpServer.closeAllConnections?.();
  await Promise.race([
    httpClosed,
    new Promise<void>((resolve) => setTimeout(resolve, 2000)),
  ]);
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

async function start(): Promise<void> {
  // One long-lived local stdio child is shared by all independent HTTP
  // requests. Only the public MCP transport is stateless.
  await oauth?.initialize();
  await desktop.initialize();

  httpServer.listen(port, host, () => {
    console.error('[self-host] Desktop Commander MCP is ready');
    console.error(`[self-host] Local endpoint: http://${host}:${port}/mcp`);
    console.error(`[self-host] Health: http://${host}:${port}/health`);
    console.error(`[self-host] Authentication mode: ${authMode}`);
    console.error('[self-host] Transport mode: stateless Streamable HTTP + JSON responses');
    if (oauth) {
      console.error(`[self-host] OAuth issuer: ${oauth.config.issuer}`);
      console.error(`[self-host] OAuth resource: ${oauth.config.resource}`);
    }
    console.error('[self-host] Vendor Remote MCP, telemetry and remote feature flags are disabled');
  });
}

start().catch(async (error) => {
  console.error('[self-host] Startup failed:', error);
  try {
    await desktop.shutdown();
  } catch {
    // Best effort after failed initialization.
  }
  process.exit(1);
});
