#!/usr/bin/env node

// MUST be first for the same libuv/thread-pool behavior as the stdio entrypoint.
import '../bootstrap.js';

import http from 'node:http';
import { randomUUID } from 'node:crypto';
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
  resolveListenHost,
  resolveListenPort,
} from './security.js';

type SessionContext = {
  server: Server;
  transport: StreamableHTTPServerTransport;
  closing: boolean;
};

applySelfHostedEnvironment();

const bearerToken = requireBearerToken();
const host = resolveListenHost();
const port = resolveListenPort();
const sessions = new Map<string, SessionContext>();
const desktop = new DesktopCommanderIntegration();
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
  if (isBearerAuthorized(req.headers.authorization, bearerToken)) return true;

  res.setHeader('www-authenticate', 'Bearer realm="desktop-commander-mcp"');
  sendMcpError(res, 401, -32001, 'Unauthorized');
  return false;
}

async function createSessionContext(): Promise<SessionContext> {
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
    return await desktop.listClientTools();
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = request.params.arguments ?? {};
    return (await desktop.callClientTool(toolName, args)) as any;
  });

  let context!: SessionContext;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, context);
      console.error(
        `[self-host] MCP session initialized: ${sessionId} (active=${sessions.size})`,
      );
    },
  });

  context = {
    server: mcpServer,
    transport,
    closing: false,
  };

  transport.onclose = () => {
    const sessionId = transport.sessionId;
    void closeSession(context, sessionId);
  };

  await mcpServer.connect(transport);
  return context;
}

async function closeSession(
  context: SessionContext,
  sessionId?: string,
): Promise<void> {
  if (context.closing) return;
  context.closing = true;

  if (sessionId) sessions.delete(sessionId);

  try {
    await context.server.close();
  } catch (error) {
    console.error('[self-host] Failed to close MCP server:', error);
  }

}

async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!authorize(req, res)) return;

  const rawSessionId = req.headers['mcp-session-id'];
  const sessionId =
    typeof rawSessionId === 'string'
      ? rawSessionId
      : Array.isArray(rawSessionId)
        ? rawSessionId[0]
        : undefined;

  if (sessionId) {
    const context = sessions.get(sessionId);
    if (!context) {
      sendMcpError(res, 404, -32001, 'MCP session not found');
      return;
    }

    await context.transport.handleRequest(req, res);
    return;
  }

  if (req.method !== 'POST') {
    sendMcpError(
      res,
      400,
      -32000,
      'A new MCP session must begin with a POST initialize request',
    );
    return;
  }

  const context = await createSessionContext();
  try {
    await context.transport.handleRequest(req, res);

    // Invalid/non-initialize POSTs do not create a session. Avoid leaving a
    // local Desktop Commander child alive in that case.
    if (!context.transport.sessionId) {
      await closeSession(context);
    }
  } catch (error) {
    await closeSession(context, context.transport.sessionId);
    throw error;
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
        vendorRemoteServices: false,
      });
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

// Long-lived SSE responses are expected for Streamable HTTP. Do not impose an
// application-level response timeout; Cloudflare Tunnel owns the public edge.
httpServer.requestTimeout = 0;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[self-host] ${signal} received; shutting down...`);

  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });

  const uniqueContexts = new Set(sessions.values());
  sessions.clear();
  await Promise.allSettled(
    [...uniqueContexts].map((context) => closeSession(context)),
  );

  try {
    await desktop.shutdown();
  } catch (error) {
    console.error('[self-host] Failed to close Desktop Commander child:', error);
  }
}

process.once('SIGINT', () => {
  void shutdown('SIGINT').finally(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').finally(() => process.exit(0));
});

async function start(): Promise<void> {
  // One local stdio child is shared by all remote HTTP sessions. This avoids a
  // new Desktop Commander process for every reconnect while preserving MCP
  // protocol state in a lightweight Server/transport pair per remote session.
  await desktop.initialize();

  httpServer.listen(port, host, () => {
    console.error('[self-host] Desktop Commander MCP is ready');
    console.error(`[self-host] Local endpoint: http://${host}:${port}/mcp`);
    console.error(`[self-host] Health: http://${host}:${port}/health`);
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
