#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveListenHost, resolveListenPort } from './security.js';

export type CloudflareLauncherConfig = {
  binary: string;
  configPath?: string;
  tunnel?: string;
  healthUrl: string;
  startupTimeoutMs: number;
};

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function healthHost(listenHost: string): string {
  if (listenHost === '0.0.0.0') return '127.0.0.1';
  if (listenHost === '::') return '::1';
  return listenHost;
}

function hostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

export function resolveCloudflareLauncherConfig(
  env: NodeJS.ProcessEnv = process.env,
): CloudflareLauncherConfig {
  const listenHost = resolveListenHost(env);
  const port = resolveListenPort(env);
  const localHost = hostForUrl(healthHost(listenHost));

  const binary = env.DC_CLOUDFLARED_BIN?.trim() || 'cloudflared';
  const configPath = env.DC_CLOUDFLARE_CONFIG?.trim()
    ? expandHome(env.DC_CLOUDFLARE_CONFIG.trim())
    : undefined;
  const tunnel = env.DC_CLOUDFLARE_TUNNEL?.trim() || undefined;

  return {
    binary,
    configPath,
    tunnel,
    healthUrl: `http://${localHost}:${port}/health`,
    startupTimeoutMs: parsePositiveInteger(
      env.DC_SELF_HOST_STARTUP_TIMEOUT_MS,
      20_000,
      'DC_SELF_HOST_STARTUP_TIMEOUT_MS',
    ),
  };
}

export function buildCloudflaredArgs(
  config: Pick<CloudflareLauncherConfig, 'configPath' | 'tunnel'>,
): string[] {
  const args = ['tunnel'];
  if (config.configPath) {
    args.push('--config', config.configPath);
  }
  args.push('run');
  if (config.tunnel) {
    args.push(config.tunnel);
  }
  return args;
}

function assertCloudflaredAvailable(binary: string): void {
  const result = spawnSync(binary, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (result.error) {
    const detail =
      (result.error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${binary} was not found in PATH`
        : result.error.message;
    throw new Error(
      `Unable to start cloudflared: ${detail}. Install it with "brew install cloudflared" or set DC_CLOUDFLARED_BIN.`,
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `cloudflared preflight failed with exit code ${result.status}: ${result.stderr.trim()}`,
    );
  }

  const version = result.stdout.trim() || result.stderr.trim();
  if (version) {
    console.error(`[launcher] ${version}`);
  }
}

async function waitForHealth(
  child: ChildProcess,
  url: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Self-host MCP exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch {
      // Server is still starting. Retry until the deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `Self-host MCP did not become healthy at ${url} within ${timeoutMs}ms`,
  );
}

async function stopChild(
  child: ChildProcess | undefined,
  name: string,
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );

  child.kill('SIGTERM');

  await Promise.race([
    exited,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          console.error(`[launcher] ${name} did not exit after SIGTERM; sending SIGKILL`);
          child.kill('SIGKILL');
        }
        resolve();
      }, 5_000),
    ),
  ]);
}

async function main(): Promise<void> {
  const config = resolveCloudflareLauncherConfig();
  assertCloudflaredAvailable(config.binary);

  const serverEntry = fileURLToPath(new URL('./http-server.js', import.meta.url));
  console.error('[launcher] Starting Desktop Commander self-host MCP...');
  const server = spawn(process.execPath, [serverEntry], {
    env: process.env,
    stdio: 'inherit',
  });

  let cloudflared: ChildProcess | undefined;
  let shuttingDown = false;
  let exitCode = 0;

  const shutdown = async (reason: string, requestedCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    exitCode = requestedCode;
    console.error(`[launcher] Shutting down: ${reason}`);
    await Promise.allSettled([
      stopChild(cloudflared, 'cloudflared'),
      stopChild(server, 'self-host MCP'),
    ]);
  };

  const signalPromise = new Promise<void>((resolve) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void shutdown(signal, 0).finally(resolve);
      });
    }
  });

  try {
    await waitForHealth(server, config.healthUrl, config.startupTimeoutMs);
    console.error(`[launcher] MCP health check passed: ${config.healthUrl}`);

    const args = buildCloudflaredArgs(config);
    console.error(
      `[launcher] Starting Cloudflare Tunnel: ${config.binary} ${args.join(' ')}`,
    );

    cloudflared = spawn(config.binary, args, {
      env: process.env,
      stdio: 'inherit',
    });

    const childExitPromise = new Promise<void>((resolve) => {
      server.once('exit', (code, signal) => {
        if (shuttingDown) return;
        void shutdown(
          `self-host MCP exited (code=${code}, signal=${signal})`,
          code && code !== 0 ? code : 1,
        ).finally(resolve);
      });

      cloudflared!.once('exit', (code, signal) => {
        if (shuttingDown) return;
        void shutdown(
          `cloudflared exited (code=${code}, signal=${signal})`,
          code && code !== 0 ? code : 1,
        ).finally(resolve);
      });

      cloudflared!.once('error', (error) => {
        if (shuttingDown) return;
        void shutdown(
          `cloudflared failed to start: ${error.message}`,
          1,
        ).finally(resolve);
      });
    });

    console.error('[launcher] Desktop Commander + Cloudflare Tunnel are running');
    await Promise.race([signalPromise, childExitPromise]);
  } catch (error) {
    exitCode = 1;
    console.error('[launcher] Startup failed:', error);
    await shutdown('startup failure', 1);
  }

  process.exitCode = exitCode;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  void main().catch((error) => {
    console.error('[launcher] Fatal error:', error);
    process.exitCode = 1;
  });
}
