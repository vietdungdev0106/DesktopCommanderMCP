import { timingSafeEqual } from 'node:crypto';

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && TRUE_VALUES.has(value.trim().toLowerCase());
}

/**
 * Self-hosted mode is intentionally isolated from Desktop Commander hosted
 * services. These values are forced, rather than defaulted, so a stale shell
 * environment cannot accidentally re-enable vendor telemetry or feature flags.
 */
export function applySelfHostedEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env.DC_SELF_HOSTED = 'true';
  env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
  env.DESKTOP_COMMANDER_DISABLE_REMOTE_SERVICES = '1';
  return env;
}

export function requireBearerToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.DC_MCP_TOKEN?.trim();
  if (!token) {
    throw new Error(
      'DC_MCP_TOKEN is required. Generate one with: openssl rand -hex 32',
    );
  }
  if (Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('DC_MCP_TOKEN must be at least 32 bytes long');
  }
  return token;
}

export function isBearerAuthorized(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorizationHeader?.startsWith('Bearer ')) return false;

  const providedToken = authorizationHeader.slice('Bearer '.length).trim();
  if (!providedToken) return false;

  const expected = Buffer.from(expectedToken, 'utf8');
  const provided = Buffer.from(providedToken, 'utf8');
  if (expected.length !== provided.length) return false;

  return timingSafeEqual(expected, provided);
}

export function resolveListenHost(env: NodeJS.ProcessEnv = process.env): string {
  const host = env.DC_MCP_HOST?.trim() || '127.0.0.1';
  if (LOOPBACK_HOSTS.has(host)) return host;

  if (isTruthyEnv(env.DC_MCP_ALLOW_NON_LOOPBACK)) {
    return host;
  }

  throw new Error(
    `Refusing to bind self-hosted MCP to non-loopback host "${host}". ` +
      'Cloudflare Tunnel does not require a public bind. Set ' +
      'DC_MCP_ALLOW_NON_LOOPBACK=true only if you understand the risk.',
  );
}

export function resolveListenPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DC_MCP_PORT?.trim() || '8765';
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid DC_MCP_PORT: ${raw}`);
  }
  return port;
}
