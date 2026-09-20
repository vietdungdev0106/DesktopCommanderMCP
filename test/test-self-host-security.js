import assert from 'node:assert/strict';
import {
  applySelfHostedEnvironment,
  isBearerAuthorized,
  requireBearerToken,
  resolveListenHost,
  resolveListenPort,
} from '../dist/self-host/security.js';

function testBearerAuth() {
  const token = 'a'.repeat(64);
  assert.equal(isBearerAuthorized(`Bearer ${token}`, token), true);
  assert.equal(isBearerAuthorized(undefined, token), false);
  assert.equal(isBearerAuthorized('Basic abc', token), false);
  assert.equal(isBearerAuthorized(`Bearer ${'b'.repeat(64)}`, token), false);
  assert.equal(isBearerAuthorized('Bearer short', token), false);
}

function testTokenValidation() {
  assert.equal(
    requireBearerToken({ DC_MCP_TOKEN: 'x'.repeat(32) }),
    'x'.repeat(32),
  );
  assert.throws(() => requireBearerToken({}), /DC_MCP_TOKEN is required/);
  assert.throws(
    () => requireBearerToken({ DC_MCP_TOKEN: 'too-short' }),
    /at least 32 bytes/,
  );
}

function testLoopbackBinding() {
  assert.equal(resolveListenHost({}), '127.0.0.1');
  assert.equal(resolveListenHost({ DC_MCP_HOST: 'localhost' }), 'localhost');
  assert.throws(
    () => resolveListenHost({ DC_MCP_HOST: '0.0.0.0' }),
    /Refusing to bind/,
  );
  assert.equal(
    resolveListenHost({
      DC_MCP_HOST: '0.0.0.0',
      DC_MCP_ALLOW_NON_LOOPBACK: 'true',
    }),
    '0.0.0.0',
  );
}

function testPortValidation() {
  assert.equal(resolveListenPort({}), 8765);
  assert.equal(resolveListenPort({ DC_MCP_PORT: '9000' }), 9000);
  assert.throws(() => resolveListenPort({ DC_MCP_PORT: '0' }), /Invalid/);
  assert.throws(() => resolveListenPort({ DC_MCP_PORT: 'abc' }), /Invalid/);
}

function testSelfHostedEnvironment() {
  const env = {
    DESKTOP_COMMANDER_DISABLE_TELEMETRY: '0',
    DESKTOP_COMMANDER_DISABLE_REMOTE_SERVICES: 'false',
  };
  applySelfHostedEnvironment(env);
  assert.equal(env.DC_SELF_HOSTED, 'true');
  assert.equal(env.DESKTOP_COMMANDER_DISABLE_TELEMETRY, '1');
  assert.equal(env.DESKTOP_COMMANDER_DISABLE_REMOTE_SERVICES, '1');
}

testBearerAuth();
testTokenValidation();
testLoopbackBinding();
testPortValidation();
testSelfHostedEnvironment();

console.log('PASS self-host security helpers');
