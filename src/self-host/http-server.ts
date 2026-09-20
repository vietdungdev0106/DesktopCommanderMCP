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
  resolveAuthMode,
  resolveListenHost,
  resolveListenPort,
} from './security.js';
import {
  SelfHostedOAuthServer,
  resolveOAuthConfig,
} from './oauth.js';

type SessionContext = {
  server: Server;
  transport: StreamableHTTPServerTransport;
  sessionId?: string;
  lastActivityAt: number;
  activeRequests: number;
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
const sessions = new Map<string, SessionContext>();
const desktop = new DesktopCommanderIntegration();
let shuttingDown = false;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const sessionIdleMs = readPositiveIntEnv(
  'DC_MCP_SESSION_IDLE_MS',
  10 * 60 * 1000,
);
const maxSessions = readPositiveIntEnv('DC_MCP_MAX_SESSIONS', 32);
const sessionSweepMs = Math.max(
  5_000,
  Math.min(60_000, Math.floor(sessionIdleMs / 2)),
);

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

  let context!: SessionContext;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      context.sessionId = sessionId;
      context.lastActivityAt = Date.now();
      sessions.set(sessionId, context);
      console.error(
        `[self-host] MCP session initialized: ${sessionId} (active=${sessions.size})`,
      );
      void enforceSessionLimit(sessionId);
    },
  });

  context = {
    server: mcpServer,
    transport,
    lastActivityAt: Date.now(),
    activeRequests: 0,
    closing: false,
  };

  transport.onclose = () => {
    void closeSession(context, context.sessionId, 'transport closed');
  };

  await mcpServer.connect(transport);
  return context;
}

async function closeSession(
  context: SessionContext,
  sessionId?: string,
  reason = 'closed',
): Promise<void> {
  if (context.closing) return;
  context.closing = true;

  const resolvedSessionId =
    sessionId ?? context.sessionId ?? context.transport.sessionId;
  if (resolvedSessionId) {
    sessions.delete(resolvedSessionId);
  }

  try {
    await context.server.close();
  } catch (error) {
    console.error('[self-host] Failed to close MCP server:', error);
  } finally {
    if (resolvedSessionId) {
      console.error(
        `[self-host] MCP session closed: ${resolvedSessionId} reason=${reason} (active=${sessions.size})`,
      );
    }
  }
}

async function enforceSessionLimit(excludeSessionId?: string): Promise<void> {
  while (sessions.size > maxSessions) {
    const candidates = [...sessions.entries()]
      .filter(
        ([sessionId, context]) =>
          sessionId !== excludeSessionId &&
          !context.closing &&
          context.activeRequests === 0,
      )
      .sort((a, b) => a[1].lastActivityAt - b[1].lastActivityAt);

    const oldest = candidates[0];
    if (!oldest) {
      console.error(
        `[self-host] Session cap exceeded (${sessions.size}/${maxSessions}) but all existing sessions are busy`,
      );
      return;
    }

    await closeSession(oldest[1], oldest[0], 'session cap eviction');
  }
}

async function reapIdleSessions(): Promise<void> {
  if (shuttingDown) return;

  const now = Date.now();
  const stale = [...sessions.entries()].filter(
    ([, context]) =>
      !context.closing &&
      context.activeRequests === 0 &&
      now - context.lastActivityAt >= sessionIdleMs,
  );

  await Promise.allSettled(
    stale.map(([sessionId, context]) =>
      closeSession(context, sessionId, 'idle timeout'),
    ),
  );
}

const sessionSweepTimer = setInterval(() => {
  void reapIdleSessions();
}, sessionSweepMs);
sessionSweepTimer.unref?.();

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

    context.lastActivityAt = Date.now();

    // GET is the long-lived server-to-client SSE stream. Do not count it as a
    // busy tool request, otherwise an abandoned stream can keep a session alive
    // forever. POST/DELETE are bounded protocol operations and protect the
    // session from eviction while they are executing.
    const countsAsActiveRequest = req.method !== 'GET';
    if (countsAsActiveRequest) context.activeRequests += 1;
    try {
      await context.transport.handleRequest(req, res);
    } finally {
      if (countsAsActiveRequest) {
        context.activeRequests = Math.max(0, context.activeRequests - 1);
      }
      context.lastActivityAt = Date.now();
    }
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
  context.activeRequests += 1;
  try {
    await context.transport.handleRequest(req, res);

    // Invalid/non-initialize POSTs do not create a session. Avoid leaving a
    // local MCP server context alive in that case.
    if (!context.sessionId && !context.transport.sessionId) {
      await closeSession(context, undefined, 'invalid initialize request');
    }
  } catch (error) {
    await closeSession(
      context,
      context.sessionId ?? context.transport.sessionId,
      'request error',
    );
    throw error;
  } finally {
    context.activeRequests = Math.max(0, context.activeRequests - 1);
    context.lastActivityAt = Date.now();
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
        authMode,
        oauthIssuer: oauth?.config.issuer,
        activeSessions: sessions.size,
        maxSessions,
        sessionIdleMs,
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

// Long-lived SSE responses are expected for Streamable HTTP. Do not impose an
// application-level response timeout; Cloudflare Tunnel owns the public edge.
httpServer.requestTimeout = 0;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(sessionSweepTimer);
  console.error(`[self-host] ${signal} received; shutting down...`);

  // Stop accepting new requests first, then close MCP transports so any
  // long-lived SSE responses can drain. Waiting for server.close() before
  // closing sessions would deadlock on those open streams.
  const httpClosed = new Promise<void>((resolve) => {
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

  // Node 18+ exposes closeAllConnections(). Use it as a final safety net for
  // non-MCP keep-alive sockets after graceful transport shutdown.
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
  // One local stdio child is shared by all remote HTTP sessions. This avoids a
  // new Desktop Commander process for every reconnect while preserving MCP
  // protocol state in a lightweight Server/transport pair per remote session.
  await oauth?.initialize();
  await desktop.initialize();

  httpServer.listen(port, host, () => {
    console.error('[self-host] Desktop Commander MCP is ready');
    console.error(`[self-host] Local endpoint: http://${host}:${port}/mcp`);
    console.error(`[self-host] Health: http://${host}:${port}/health`);
    console.error(`[self-host] Authentication mode: ${authMode}`);
    console.error(
      `[self-host] Session policy: max=${maxSessions}, idle=${sessionIdleMs}ms`,
    );
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
