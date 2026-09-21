import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  buildCloudflaredArgs,
  resolveCloudflareLauncherConfig,
} from '../dist/self-host/cloudflare-launcher.js';

const baseEnv = {
  DC_MCP_HOST: '127.0.0.1',
  DC_MCP_PORT: '8765',
};

const defaults = resolveCloudflareLauncherConfig(baseEnv);
assert.equal(defaults.binary, 'cloudflared');
assert.equal(defaults.healthUrl, 'http://127.0.0.1:8765/health');
assert.equal(defaults.startupTimeoutMs, 20000);
assert.equal(defaults.configPath, undefined);
assert.equal(defaults.tunnel, undefined);
assert.deepEqual(buildCloudflaredArgs(defaults), ['tunnel', 'run']);

const named = resolveCloudflareLauncherConfig({
  ...baseEnv,
  DC_CLOUDFLARED_BIN: '/opt/homebrew/bin/cloudflared',
  DC_CLOUDFLARE_CONFIG: '~/.cloudflared/desktop-commander.yml',
  DC_CLOUDFLARE_TUNNEL: 'desktop-commander',
  DC_SELF_HOST_STARTUP_TIMEOUT_MS: '45000',
});
assert.equal(named.binary, '/opt/homebrew/bin/cloudflared');
assert.equal(
  named.configPath,
  path.join(os.homedir(), '.cloudflared/desktop-commander.yml'),
);
assert.equal(named.tunnel, 'desktop-commander');
assert.equal(named.startupTimeoutMs, 45000);
assert.deepEqual(buildCloudflaredArgs(named), [
  'tunnel',
  '--config',
  path.join(os.homedir(), '.cloudflared/desktop-commander.yml'),
  'run',
  'desktop-commander',
]);

const ipv6 = resolveCloudflareLauncherConfig({
  DC_MCP_HOST: '::1',
  DC_MCP_PORT: '9000',
});
assert.equal(ipv6.healthUrl, 'http://[::1]:9000/health');

assert.throws(
  () =>
    resolveCloudflareLauncherConfig({
      ...baseEnv,
      DC_SELF_HOST_STARTUP_TIMEOUT_MS: '0',
    }),
  /positive integer/,
);

console.log('PASS self-host Cloudflare launcher helpers');
