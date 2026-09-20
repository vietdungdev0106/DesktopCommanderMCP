import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { CONFIG_FILE } from '../config.js';

export const OAUTH_TOOL_SCOPE = 'mcp:tools';
export const OAUTH_OFFLINE_SCOPE = 'offline_access';
const SUPPORTED_SCOPES = [OAUTH_TOOL_SCOPE, OAUTH_OFFLINE_SCOPE] as const;
const DEFAULT_ACCESS_TTL_SECONDS = 60 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FAILED_PASSWORD_ATTEMPTS = 10;
const FAILED_PASSWORD_WINDOW_MS = 5 * 60 * 1000;

type TokenRecord = {
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
};

type RegisteredClient = {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
};

type OAuthStore = {
  version: 1;
  clients: Record<string, RegisteredClient>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
};

type ClientValidation = {
  clientId: string;
  redirectUri: string;
  displayName: string;
};

type PendingAuthorization = ClientValidation & {
  id: string;
  state?: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
};

type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  expiresAt: number;
};

export type OAuthConfig = {
  issuer: string;
  resource: string;
  adminPassword: string;
  storePath: string;
  allowedCimdHosts: Set<string>;
  allowedRedirectOrigins: Set<string>;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
};

function normalizeHttpsOrigin(raw: string, name: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https://`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, query, or fragment`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} must be an origin URL without a path`);
  }
  return url.origin;
}

function parseCsvSet(
  raw: string | undefined,
  fallback: string[],
  normalize: (value: string) => string = (value) => value,
): Set<string> {
  const values = (raw ?? fallback.join(','))
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalize);
  if (values.length === 0) {
    throw new Error('OAuth allow-list cannot be empty');
  }
  return new Set(values);
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function resolveOAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
): OAuthConfig {
  const issuerRaw = env.DC_OAUTH_ISSUER?.trim();
  if (!issuerRaw) {
    throw new Error(
      'DC_OAUTH_ISSUER is required in OAuth mode, e.g. https://mcp.example.com',
    );
  }
  const issuer = normalizeHttpsOrigin(issuerRaw, 'DC_OAUTH_ISSUER');

  const resourceRaw = env.DC_OAUTH_RESOURCE?.trim() || issuer;
  const resource = normalizeHttpsOrigin(resourceRaw, 'DC_OAUTH_RESOURCE');

  const adminPassword = env.DC_OAUTH_ADMIN_PASSWORD ?? '';
  if (Buffer.byteLength(adminPassword, 'utf8') < 16) {
    throw new Error('DC_OAUTH_ADMIN_PASSWORD must be at least 16 bytes long');
  }

  const allowedCimdHosts = parseCsvSet(
    env.DC_OAUTH_ALLOWED_CIMD_HOSTS,
    ['chatgpt.com'],
    (value) => value.toLowerCase(),
  );

  const allowedRedirectOrigins = parseCsvSet(
    env.DC_OAUTH_ALLOWED_REDIRECT_ORIGINS,
    ['https://chatgpt.com'],
    (value) => normalizeHttpsOrigin(value, 'DC_OAUTH_ALLOWED_REDIRECT_ORIGINS'),
  );

  const storePath =
    env.DC_OAUTH_STORE_PATH?.trim() ||
    path.join(path.dirname(CONFIG_FILE), 'self-host-oauth.json');

  return {
    issuer,
    resource,
    adminPassword,
    storePath,
    allowedCimdHosts,
    allowedRedirectOrigins,
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DC_OAUTH_ACCESS_TTL_SECONDS,
      DEFAULT_ACCESS_TTL_SECONDS,
      'DC_OAUTH_ACCESS_TTL_SECONDS',
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DC_OAUTH_REFRESH_TTL_SECONDS,
      DEFAULT_REFRESH_TTL_SECONDS,
      'DC_OAUTH_REFRESH_TTL_SECONDS',
    ),
  };
}

function emptyStore(): OAuthStore {
  return {
    version: 1,
    clients: {},
    accessTokens: {},
    refreshTokens: {},
  };
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseScopes(raw: string | undefined): string[] {
  if (!raw?.trim()) return [...SUPPORTED_SCOPES];
  return [...new Set(raw.trim().split(/\s+/).filter(Boolean))];
}

function validateScopes(scopes: string[]): void {
  const supported = new Set<string>(SUPPORTED_SCOPES);
  for (const scope of scopes) {
    if (!supported.has(scope)) {
      throw new Error(`Unsupported OAuth scope: ${scope}`);
    }
  }
  if (!scopes.includes(OAUTH_TOOL_SCOPE)) {
    throw new Error(`Required OAuth scope missing: ${OAUTH_TOOL_SCOPE}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    pragma: 'no-cache',
  });
  res.end(body);
}

function sendHtml(
  res: http.ServerResponse,
  statusCode: number,
  body: string,
): void {
  res.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

function oauthError(
  res: http.ServerResponse,
  statusCode: number,
  error: string,
  description: string,
): void {
  sendJson(res, statusCode, {
    error,
    error_description: description,
  });
}

function isValidPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isValidPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export class SelfHostedOAuthServer {
  private store: OAuthStore = emptyStore();
  private pendingAuthorizations = new Map<string, PendingAuthorization>();
  private authorizationCodes = new Map<string, AuthorizationCode>();
  private failedPasswordAttempts: number[] = [];
  private persistChain: Promise<void> = Promise.resolve();

  constructor(readonly config: OAuthConfig) {}

  get protectedResourceMetadataUrl(): string {
    return `${this.config.issuer}/.well-known/oauth-protected-resource`;
  }

  challengeHeader(): string {
    return (
      `Bearer resource_metadata="${this.protectedResourceMetadataUrl}", ` +
      `scope="${OAUTH_TOOL_SCOPE}"`
    );
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.config.storePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<OAuthStore>;
      if (
        parsed.version !== 1 ||
        typeof parsed.clients !== 'object' ||
        typeof parsed.accessTokens !== 'object' ||
        typeof parsed.refreshTokens !== 'object'
      ) {
        throw new Error('Unsupported or invalid OAuth store format');
      }
      this.store = parsed as OAuthStore;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      this.store = emptyStore();
    }

    if (this.purgeExpiredTokens()) {
      await this.persist();
    }
  }

  canHandle(pathname: string): boolean {
    return (
      pathname === '/.well-known/oauth-protected-resource' ||
      pathname === '/.well-known/oauth-authorization-server' ||
      pathname === '/authorize' ||
      pathname === '/token' ||
      pathname === '/register'
    );
  }

  authenticateBearer(
    authorizationHeader: string | undefined,
  ): TokenRecord | null {
    const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;

    const record = this.store.accessTokens[hashToken(match[1].trim())];
    if (!record) return null;
    if (record.expiresAt <= Date.now()) return null;
    if (record.resource !== this.config.resource) return null;
    if (!record.scope.split(/\s+/).includes(OAUTH_TOOL_SCOPE)) return null;
    return record;
  }

  async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/oauth-protected-resource'
    ) {
      this.handleProtectedResourceMetadata(res);
      return;
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/.well-known/oauth-authorization-server'
    ) {
      this.handleAuthorizationServerMetadata(res);
      return;
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      await this.handleAuthorizeGet(res, url);
      return;
    }

    if (url.pathname === '/authorize' && req.method === 'POST') {
      await this.handleAuthorizePost(req, res);
      return;
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      await this.handleToken(req, res);
      return;
    }

    if (url.pathname === '/register' && req.method === 'POST') {
      await this.handleRegistration(req, res);
      return;
    }

    oauthError(res, 405, 'invalid_request', 'Method not allowed');
  }

  private handleProtectedResourceMetadata(res: http.ServerResponse): void {
    sendJson(res, 200, {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      scopes_supported: [...SUPPORTED_SCOPES],
      bearer_methods_supported: ['header'],
    });
  }

  private handleAuthorizationServerMetadata(res: http.ServerResponse): void {
    sendJson(res, 200, {
      issuer: this.config.issuer,
      authorization_response_iss_parameter_supported: true,
      authorization_endpoint: `${this.config.issuer}/authorize`,
      token_endpoint: `${this.config.issuer}/token`,
      registration_endpoint: `${this.config.issuer}/register`,
      client_id_metadata_document_supported: true,
      token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: [...SUPPORTED_SCOPES],
    });
  }

  private async handleAuthorizeGet(
    res: http.ServerResponse,
    url: URL,
  ): Promise<void> {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? undefined;

    let client: ClientValidation;
    try {
      client = await this.validateClient(clientId, redirectUri);
    } catch (error) {
      sendHtml(
        res,
        400,
        this.renderErrorPage(
          'Invalid OAuth client',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    const fail = (error: string, description: string) => {
      this.redirectAuthorizationError(
        res,
        client.redirectUri,
        state,
        error,
        description,
      );
    };

    if (url.searchParams.get('response_type') !== 'code') {
      fail('unsupported_response_type', 'Only response_type=code is supported');
      return;
    }

    const resource = url.searchParams.get('resource') ?? '';
    if (resource !== this.config.resource) {
      fail('invalid_target', 'OAuth resource does not match this MCP server');
      return;
    }

    const codeChallenge = url.searchParams.get('code_challenge') ?? '';
    if (
      url.searchParams.get('code_challenge_method') !== 'S256' ||
      !isValidPkceChallenge(codeChallenge)
    ) {
      fail('invalid_request', 'PKCE S256 code_challenge is required');
      return;
    }

    let scopes: string[];
    try {
      scopes = parseScopes(url.searchParams.get('scope') ?? undefined);
      validateScopes(scopes);
    } catch (error) {
      fail(
        'invalid_scope',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    this.cleanupTransientState();

    const id = randomToken(24);
    const pending: PendingAuthorization = {
      ...client,
      id,
      state,
      resource,
      scope: scopes.join(' '),
      codeChallenge,
      expiresAt: Date.now() + AUTH_REQUEST_TTL_MS,
    };
    this.pendingAuthorizations.set(id, pending);

    sendHtml(res, 200, this.renderLoginPage(pending));
  }

  private async handleAuthorizePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch (error) {
      sendHtml(
        res,
        400,
        this.renderErrorPage(
          'Invalid authorization request',
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }

    const requestId = form.get('request_id') ?? '';
    const pending = this.pendingAuthorizations.get(requestId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingAuthorizations.delete(requestId);
      sendHtml(
        res,
        400,
        this.renderErrorPage(
          'Authorization request expired',
          'Start the connection again from ChatGPT.',
        ),
      );
      return;
    }

    this.trimFailedPasswordAttempts();
    if (this.failedPasswordAttempts.length >= MAX_FAILED_PASSWORD_ATTEMPTS) {
      sendHtml(
        res,
        429,
        this.renderLoginPage(
          pending,
          'Too many failed attempts. Try again in a few minutes.',
        ),
      );
      return;
    }

    const password = form.get('password') ?? '';
    if (!constantTimeTextEqual(password, this.config.adminPassword)) {
      this.failedPasswordAttempts.push(Date.now());
      sendHtml(
        res,
        401,
        this.renderLoginPage(pending, 'Incorrect authorization password.'),
      );
      return;
    }

    this.failedPasswordAttempts = [];
    this.pendingAuthorizations.delete(requestId);

    const code = randomToken(32);
    this.authorizationCodes.set(code, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      resource: pending.resource,
      scope: pending.scope,
      codeChallenge: pending.codeChallenge,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    });

    const target = new URL(pending.redirectUri);
    target.searchParams.set('code', code);
    if (pending.state) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.config.issuer);

    res.writeHead(302, {
      location: target.toString(),
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
    res.end();
  }

  private async handleToken(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(await readBody(req));
    } catch {
      oauthError(res, 400, 'invalid_request', 'Invalid token request body');
      return;
    }

    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      await this.exchangeAuthorizationCode(form, res);
      return;
    }
    if (grantType === 'refresh_token') {
      await this.exchangeRefreshToken(form, res);
      return;
    }

    oauthError(
      res,
      400,
      'unsupported_grant_type',
      'Only authorization_code and refresh_token are supported',
    );
  }

  private async exchangeAuthorizationCode(
    form: URLSearchParams,
    res: http.ServerResponse,
  ): Promise<void> {
    const code = form.get('code') ?? '';
    const record = this.authorizationCodes.get(code);
    this.authorizationCodes.delete(code);

    if (!record || record.expiresAt <= Date.now()) {
      oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired');
      return;
    }

    const clientId = form.get('client_id') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const resource = form.get('resource') ?? '';
    const verifier = form.get('code_verifier') ?? '';

    if (
      clientId !== record.clientId ||
      redirectUri !== record.redirectUri ||
      resource !== record.resource ||
      resource !== this.config.resource
    ) {
      oauthError(res, 400, 'invalid_grant', 'Authorization code binding mismatch');
      return;
    }

    if (
      !isValidPkceVerifier(verifier) ||
      !constantTimeTextEqual(pkceS256(verifier), record.codeChallenge)
    ) {
      oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      return;
    }

    await this.issueTokens(res, {
      clientId,
      resource,
      scope: record.scope,
    });
  }

  private async exchangeRefreshToken(
    form: URLSearchParams,
    res: http.ServerResponse,
  ): Promise<void> {
    const refreshToken = form.get('refresh_token') ?? '';
    const refreshHash = hashToken(refreshToken);
    const record = this.store.refreshTokens[refreshHash];

    if (!record || record.expiresAt <= Date.now()) {
      if (record) {
        delete this.store.refreshTokens[refreshHash];
        await this.persist();
      }
      oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      return;
    }

    const clientId = form.get('client_id') ?? '';
    const resource = form.get('resource') ?? '';
    if (
      clientId !== record.clientId ||
      resource !== record.resource ||
      resource !== this.config.resource
    ) {
      oauthError(res, 400, 'invalid_grant', 'Refresh token binding mismatch');
      return;
    }

    let scope = record.scope;
    const requestedScope = form.get('scope');
    if (requestedScope) {
      let requested: string[];
      try {
        requested = parseScopes(requestedScope);
        validateScopes(requested);
      } catch (error) {
        oauthError(
          res,
          400,
          'invalid_scope',
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
      const original = new Set(record.scope.split(/\s+/));
      if (requested.some((item) => !original.has(item))) {
        oauthError(res, 400, 'invalid_scope', 'Refresh scope exceeds original grant');
        return;
      }
      scope = requested.join(' ');
    }

    // Refresh tokens are rotated on every successful use.
    delete this.store.refreshTokens[refreshHash];
    await this.issueTokens(res, {
      clientId,
      resource,
      scope,
    });
  }

  private async issueTokens(
    res: http.ServerResponse,
    grant: Omit<TokenRecord, 'expiresAt'>,
  ): Promise<void> {
    this.purgeExpiredTokens();

    const accessToken = randomToken(32);
    const refreshToken = randomToken(48);
    const now = Date.now();

    this.store.accessTokens[hashToken(accessToken)] = {
      ...grant,
      expiresAt: now + this.config.accessTokenTtlSeconds * 1000,
    };
    this.store.refreshTokens[hashToken(refreshToken)] = {
      ...grant,
      expiresAt: now + this.config.refreshTokenTtlSeconds * 1000,
    };

    await this.persist();

    sendJson(res, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: grant.scope,
    });
  }

  private async handleRegistration(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    let body: any;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      oauthError(res, 400, 'invalid_client_metadata', 'Registration body must be JSON');
      return;
    }

    const redirectUris = Array.isArray(body?.redirect_uris)
      ? [...new Set(body.redirect_uris.filter((item: unknown) => typeof item === 'string'))]
      : [];

    if (redirectUris.length === 0 || redirectUris.length > 10) {
      oauthError(
        res,
        400,
        'invalid_redirect_uri',
        'One to ten redirect_uris are required',
      );
      return;
    }

    try {
      for (const redirectUri of redirectUris) {
        this.assertRedirectUriAllowed(redirectUri);
      }
    } catch (error) {
      oauthError(
        res,
        400,
        'invalid_redirect_uri',
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    const tokenMethod = body?.token_endpoint_auth_method ?? 'none';
    if (tokenMethod !== 'none') {
      oauthError(
        res,
        400,
        'invalid_client_metadata',
        'Only token_endpoint_auth_method=none is supported',
      );
      return;
    }

    if (
      Array.isArray(body?.grant_types) &&
      !body.grant_types.includes('authorization_code')
    ) {
      oauthError(
        res,
        400,
        'invalid_client_metadata',
        'authorization_code grant is required',
      );
      return;
    }

    if (
      Array.isArray(body?.response_types) &&
      !body.response_types.includes('code')
    ) {
      oauthError(
        res,
        400,
        'invalid_client_metadata',
        'code response type is required',
      );
      return;
    }

    const clientId = `dc_${randomToken(24)}`;
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      clientName:
        typeof body?.client_name === 'string'
          ? body.client_name.slice(0, 200)
          : undefined,
      createdAt: Date.now(),
    };
    this.store.clients[clientId] = client;
    await this.persist();

    sendJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_name: client.clientName,
    });
  }

  private async validateClient(
    clientId: string,
    redirectUri: string,
  ): Promise<ClientValidation> {
    if (!clientId || !redirectUri) {
      throw new Error('client_id and redirect_uri are required');
    }

    this.assertRedirectUriAllowed(redirectUri);

    const registered = this.store.clients[clientId];
    if (registered) {
      if (!registered.redirectUris.includes(redirectUri)) {
        throw new Error('redirect_uri is not registered for this client');
      }
      return {
        clientId,
        redirectUri,
        displayName: registered.clientName || 'Registered MCP client',
      };
    }

    let metadataUrl: URL;
    try {
      metadataUrl = new URL(clientId);
    } catch {
      throw new Error('Unknown OAuth client_id');
    }

    if (
      metadataUrl.protocol !== 'https:' ||
      metadataUrl.username ||
      metadataUrl.password ||
      metadataUrl.port ||
      metadataUrl.search ||
      metadataUrl.hash
    ) {
      throw new Error('CIMD client_id must be a clean HTTPS URL');
    }

    if (!this.config.allowedCimdHosts.has(metadataUrl.hostname.toLowerCase())) {
      throw new Error('CIMD client_id host is not allowed');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let response: Response;
    try {
      response = await fetch(metadataUrl, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Unable to fetch CIMD metadata (HTTP ${response.status})`);
    }

    const metadata = (await response.json()) as any;
    if (
      metadata?.client_id !== undefined &&
      metadata.client_id !== clientId
    ) {
      throw new Error('CIMD client_id metadata mismatch');
    }

    if (
      !Array.isArray(metadata?.redirect_uris) ||
      !metadata.redirect_uris.includes(redirectUri)
    ) {
      throw new Error('redirect_uri is not present in CIMD metadata');
    }

    const authMethods = Array.isArray(
      metadata?.token_endpoint_auth_methods_supported,
    )
      ? metadata.token_endpoint_auth_methods_supported
      : metadata?.token_endpoint_auth_method
        ? [metadata.token_endpoint_auth_method]
        : [];

    if (!authMethods.includes('none')) {
      throw new Error('CIMD client does not support public-client token auth');
    }

    return {
      clientId,
      redirectUri,
      displayName:
        typeof metadata?.client_name === 'string'
          ? metadata.client_name.slice(0, 200)
          : metadataUrl.hostname,
    };
  }

  private assertRedirectUriAllowed(redirectUri: string): void {
    let url: URL;
    try {
      url = new URL(redirectUri);
    } catch {
      throw new Error('redirect_uri must be an absolute URL');
    }

    if (url.username || url.password || url.hash) {
      throw new Error('redirect_uri must not include credentials or a fragment');
    }

    if (!this.config.allowedRedirectOrigins.has(url.origin)) {
      throw new Error(
        `redirect_uri origin is not allowed: ${url.origin}`,
      );
    }
  }

  private redirectAuthorizationError(
    res: http.ServerResponse,
    redirectUri: string,
    state: string | undefined,
    error: string,
    description: string,
  ): void {
    const target = new URL(redirectUri);
    target.searchParams.set('error', error);
    target.searchParams.set('error_description', description);
    if (state) target.searchParams.set('state', state);
    target.searchParams.set('iss', this.config.issuer);

    res.writeHead(302, {
      location: target.toString(),
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
    res.end();
  }

  private renderLoginPage(
    pending: PendingAuthorization,
    errorMessage?: string,
  ): string {
    const error = errorMessage
      ? `<p class="error">${escapeHtml(errorMessage)}</p>`
      : '';

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Desktop Commander</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0d10;color:#f4f6f8;margin:0;min-height:100vh;display:grid;place-items:center}
main{width:min(92vw,520px);background:#15191f;border:1px solid #2b313a;border-radius:16px;padding:28px;box-sizing:border-box}
h1{font-size:24px;margin:0 0 12px}p{line-height:1.5;color:#b9c1cc}.meta{background:#0f1216;border-radius:10px;padding:14px;margin:18px 0;font-size:14px;word-break:break-word}.meta strong{color:#fff}
label{display:block;margin:18px 0 8px;font-weight:600}input{width:100%;box-sizing:border-box;padding:12px;border-radius:9px;border:1px solid #3b4450;background:#0d1014;color:#fff;font-size:16px}
button{width:100%;margin-top:16px;padding:12px;border:0;border-radius:9px;font-size:16px;font-weight:700;cursor:pointer}.error{color:#ff8c8c}
small{display:block;margin-top:16px;color:#8e99a7}
</style>
</head>
<body>
<main>
<h1>Authorize Desktop Commander</h1>
<p>ChatGPT is requesting permission to use the tools exposed by your self-hosted Desktop Commander.</p>
<div class="meta">
<strong>Client:</strong> ${escapeHtml(pending.displayName)}<br>
<strong>Scopes:</strong> ${escapeHtml(pending.scope)}<br>
<strong>Resource:</strong> ${escapeHtml(pending.resource)}
</div>
${error}
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(pending.id)}">
<label for="password">Authorization password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Authorize ChatGPT</button>
</form>
<small>This is the password from DC_OAUTH_ADMIN_PASSWORD, not your ChatGPT password.</small>
</main>
</body>
</html>`;
  }

  private renderErrorPage(title: string, message: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  }

  private trimFailedPasswordAttempts(): void {
    const cutoff = Date.now() - FAILED_PASSWORD_WINDOW_MS;
    this.failedPasswordAttempts = this.failedPasswordAttempts.filter(
      (timestamp) => timestamp >= cutoff,
    );
  }

  private cleanupTransientState(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingAuthorizations) {
      if (pending.expiresAt <= now) this.pendingAuthorizations.delete(id);
    }
    for (const [code, record] of this.authorizationCodes) {
      if (record.expiresAt <= now) this.authorizationCodes.delete(code);
    }
  }

  private purgeExpiredTokens(): boolean {
    const now = Date.now();
    let changed = false;
    for (const [hash, record] of Object.entries(this.store.accessTokens)) {
      if (record.expiresAt <= now) {
        delete this.store.accessTokens[hash];
        changed = true;
      }
    }
    for (const [hash, record] of Object.entries(this.store.refreshTokens)) {
      if (record.expiresAt <= now) {
        delete this.store.refreshTokens[hash];
        changed = true;
      }
    }
    return changed;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.store, null, 2) + '\n';
    const target = this.config.storePath;
    this.persistChain = this.persistChain.then(async () => {
      const directory = path.dirname(target);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = `${target}.tmp-${process.pid}-${randomToken(6)}`;
      await fs.writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, target);
      await fs.chmod(target, 0o600);
    });
    return this.persistChain;
  }
}
