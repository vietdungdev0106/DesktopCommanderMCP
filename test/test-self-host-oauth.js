import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SelfHostedOAuthServer,
  pkceS256,
  resolveOAuthConfig,
} from '../dist/self-host/oauth.js';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-oauth-test-'));
const issuer = 'https://mcp.example.test';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const adminPassword = 'correct-horse-battery-staple';

const config = resolveOAuthConfig({
  DC_OAUTH_ISSUER: issuer,
  DC_OAUTH_ADMIN_PASSWORD: adminPassword,
  DC_OAUTH_STORE_PATH: path.join(tempDir, 'oauth.json'),
  DC_OAUTH_ALLOWED_CIMD_HOSTS: 'chatgpt.com',
  DC_OAUTH_ALLOWED_REDIRECT_ORIGINS: 'https://chatgpt.com',
  DC_OAUTH_ACCESS_TTL_SECONDS: '3600',
  DC_OAUTH_REFRESH_TTL_SECONDS: '86400',
});

assert.equal(config.issuer, issuer);
assert.equal(config.resource, issuer);
assert.equal(config.adminPassword, adminPassword);

// Custom passwords are accepted exactly as provided, including values shorter
// than the previous 16-byte minimum and common shell-special characters.
const customPassword = 'MyP@ss!$&7';
const customPasswordConfig = resolveOAuthConfig({
  DC_OAUTH_ISSUER: issuer,
  DC_OAUTH_ADMIN_PASSWORD: customPassword,
});
assert.equal(customPasswordConfig.adminPassword, customPassword);

assert.throws(
  () =>
    resolveOAuthConfig({
      DC_OAUTH_ISSUER: issuer,
      DC_OAUTH_ADMIN_PASSWORD: '',
    }),
  /must not be empty/,
);
assert.throws(
  () =>
    resolveOAuthConfig({
      DC_OAUTH_ISSUER: 'http://insecure.example.test',
      DC_OAUTH_ADMIN_PASSWORD: adminPassword,
    }),
  /https/,
);

let oauth = new SelfHostedOAuthServer(config);
await oauth.initialize();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', config.issuer);
    if (!oauth.canHandle(url.pathname)) {
      res.writeHead(404);
      res.end();
      return;
    }
    await oauth.handleHttp(req, res, url);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(error) }));
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
assert.ok(address && typeof address !== 'string');
const localBase = `http://127.0.0.1:${address.port}`;

try {
  const protectedMetadata = await fetch(
    `${localBase}/.well-known/oauth-protected-resource`,
  ).then((response) => response.json());
  assert.equal(protectedMetadata.resource, issuer);
  assert.deepEqual(protectedMetadata.authorization_servers, [issuer]);
  assert.ok(protectedMetadata.scopes_supported.includes('mcp:tools'));

  const authMetadata = await fetch(
    `${localBase}/.well-known/oauth-authorization-server`,
  ).then((response) => response.json());
  assert.equal(authMetadata.issuer, issuer);
  assert.equal(authMetadata.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(authMetadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(authMetadata.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(authMetadata.client_id_metadata_document_supported, true);
  assert.match(
    oauth.challengeHeader(),
    /resource_metadata="https:\/\/mcp\.example\.test\/\.well-known\/oauth-protected-resource"/,
  );
  assert.match(oauth.challengeHeader(), /scope="mcp:tools"/);

  // ChatGPT currently publishes both the plural list and a legacy singular
  // preference for private_key_jwt. This server advertises only public-client
  // auth ("none"), so CIMD validation must select the common method from the
  // plural list instead of rejecting the singular preference.
  const originalFetch = globalThis.fetch;
  const cimdClientId = 'https://chatgpt.com/oauth/client.json';
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    if (target === cimdClientId) {
      return new Response(
        JSON.stringify({
          client_id: cimdClientId,
          client_name: 'ChatGPT',
          redirect_uris: [redirectUri],
          token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
          token_endpoint_auth_method: 'private_key_jwt',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    return originalFetch(input, init);
  };

  try {
    const cimdAuthorizeUrl = new URL(`${localBase}/authorize`);
    cimdAuthorizeUrl.searchParams.set('response_type', 'code');
    cimdAuthorizeUrl.searchParams.set('client_id', cimdClientId);
    cimdAuthorizeUrl.searchParams.set('redirect_uri', redirectUri);
    cimdAuthorizeUrl.searchParams.set('scope', 'mcp:tools offline_access');
    cimdAuthorizeUrl.searchParams.set('state', 'cimd-state');
    cimdAuthorizeUrl.searchParams.set('resource', issuer);
    cimdAuthorizeUrl.searchParams.set(
      'code_challenge',
      pkceS256('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'),
    );
    cimdAuthorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const cimdAuthorizeResponse = await originalFetch(cimdAuthorizeUrl);
    assert.equal(cimdAuthorizeResponse.status, 200);
    assert.match(await cimdAuthorizeResponse.text(), /Authorize Desktop Commander/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const badRegistration = await fetch(`${localBase}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://evil.example/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(badRegistration.status, 400);

  const registrationResponse = await fetch(`${localBase}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'ChatGPT test client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    }),
  });
  assert.equal(registrationResponse.status, 201);
  const registration = await registrationResponse.json();
  assert.match(registration.client_id, /^dc_/);

  const verifier =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
  const challenge = pkceS256(verifier);
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);

  const authorizeUrl = new URL(`${localBase}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', registration.client_id);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('scope', 'mcp:tools offline_access');
  authorizeUrl.searchParams.set('state', 'test-state');
  authorizeUrl.searchParams.set('resource', issuer);
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  const authorizeResponse = await fetch(authorizeUrl);
  assert.equal(authorizeResponse.status, 200);
  const authorizeHtml = await authorizeResponse.text();
  const requestId = authorizeHtml.match(
    /name="request_id" value="([A-Za-z0-9_-]+)"/,
  )?.[1];
  assert.ok(requestId);

  // Simulate a process restart after ChatGPT has opened the authorization page.
  // The pending request must survive and still accept the submitted password.
  oauth = new SelfHostedOAuthServer(config);
  await oauth.initialize();

  const wrongPassword = await fetch(`${localBase}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      request_id: requestId,
      password: 'wrong-password-value',
    }),
    redirect: 'manual',
  });
  assert.equal(wrongPassword.status, 401);

  const approveResponse = await fetch(`${localBase}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      request_id: requestId,
      password: adminPassword,
    }),
    redirect: 'manual',
  });
  assert.equal(approveResponse.status, 302);

  const callback = new URL(approveResponse.headers.get('location'));
  assert.equal(callback.origin, 'https://chatgpt.com');
  assert.equal(callback.searchParams.get('state'), 'test-state');
  assert.equal(callback.searchParams.get('iss'), issuer);
  const code = callback.searchParams.get('code');
  assert.ok(code);

  // Simulate another process restart after approval but before ChatGPT exchanges
  // the authorization code. The short-lived code must survive exactly once.
  oauth = new SelfHostedOAuthServer(config);
  await oauth.initialize();

  const tokenResponse = await fetch(`${localBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: issuer,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.ok(
    oauth.authenticateBearer(`Bearer ${tokens.access_token}`),
    'new access token should authenticate',
  );

  const reusedAuthorizationCode = await fetch(`${localBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: issuer,
    }),
  });
  assert.equal(reusedAuthorizationCode.status, 400);
  const reusedAuthorizationCodeBody = await reusedAuthorizationCode.json();
  assert.equal(reusedAuthorizationCodeBody.error, 'invalid_grant');

  const refreshResponse = await fetch(`${localBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: registration.client_id,
    }),
  });
  assert.equal(refreshResponse.status, 200);
  const refreshed = await refreshResponse.json();
  assert.ok(refreshed.access_token);
  assert.ok(refreshed.refresh_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  assert.ok(oauth.authenticateBearer(`Bearer ${refreshed.access_token}`));

  const reusedRefresh = await fetch(`${localBase}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: registration.client_id,
    }),
  });
  assert.equal(reusedRefresh.status, 400);
  const reusedBody = await reusedRefresh.json();
  assert.equal(reusedBody.error, 'invalid_grant');

  const persistedRaw = await fs.readFile(config.storePath, 'utf8');
  const persisted = JSON.parse(persistedRaw);
  assert.equal(persisted.version, 1);
  assert.ok(Object.keys(persisted.clients).length >= 1);
  assert.ok(Object.keys(persisted.refreshTokens).length >= 1);
  assert.ok(persisted.pendingAuthorizations);
  assert.ok(persisted.authorizationCodes);
  assert.ok(
    !persistedRaw.includes(requestId),
    'raw authorization request IDs must not be persisted',
  );
  assert.ok(
    !persistedRaw.includes(code),
    'raw authorization codes must not be persisted',
  );

  console.log('PASS self-host OAuth 2.1 + PKCE flow');
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}
