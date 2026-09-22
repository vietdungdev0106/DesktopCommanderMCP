import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `self-host exited before health check (code=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

const port = await getFreePort();
const token = 's'.repeat(64);
let stderr = '';

const child = spawn(process.execPath, ['dist/self-host/http-server.js'], {
  env: {
    ...process.env,
    DC_AUTH_MODE: 'bearer',
    DC_MCP_TOKEN: token,
    DC_MCP_HOST: '127.0.0.1',
    DC_MCP_PORT: String(port),
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const base = `http://127.0.0.1:${port}`;
const commonHeaders = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

try {
  const health = await waitForHealth(`${base}/health`, child);
  assert.equal(health.status, 'ok');
  assert.equal(health.transportMode, 'stateless-json');
  assert.equal(health.activeMcpRequests, 0);
  assert.equal('activeSessions' in health, false);

  const initialize = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'self-host-stateless-test',
          version: '1.0.0',
        },
      },
    }),
  });

  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get('mcp-session-id'), null);
  assert.match(
    initialize.headers.get('content-type') ?? '',
    /application\/json/i,
  );
  const initializeBody = await initialize.json();
  assert.equal(initializeBody.id, 1);
  assert.equal(initializeBody.result.serverInfo.name, 'desktop-commander-self-hosted');

  // A second independent POST must work without carrying any MCP session ID.
  // This is the key regression check for the previous session-churn design.
  const listTools = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'mcp-protocol-version': initializeBody.result.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }),
  });

  assert.equal(listTools.status, 200);
  assert.equal(listTools.headers.get('mcp-session-id'), null);
  assert.match(
    listTools.headers.get('content-type') ?? '',
    /application\/json/i,
  );
  const listToolsBody = await listTools.json();
  assert.equal(listToolsBody.id, 2);
  assert(Array.isArray(listToolsBody.result.tools));
  assert(listToolsBody.result.tools.length > 0);

  const getConfigTool = listToolsBody.result.tools.find(
    (tool) => tool.name === 'get_config',
  );
  assert(getConfigTool, 'get_config tool must be exposed');
  const configTemplateUri = getConfigTool._meta?.['openai/outputTemplate'];
  assert.equal(
    configTemplateUri,
    'ui://desktop-commander/config-editor',
  );

  const listResources = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'mcp-protocol-version': initializeBody.result.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
      params: {},
    }),
  });

  assert.equal(listResources.status, 200);
  const listResourcesBody = await listResources.json();
  assert.equal(listResourcesBody.id, 3);
  assert(Array.isArray(listResourcesBody.result.resources));
  assert(
    listResourcesBody.result.resources.some(
      (resource) => resource.uri === configTemplateUri,
    ),
    'resources/list must expose the URI referenced by get_config outputTemplate',
  );

  const readResource = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'mcp-protocol-version': initializeBody.result.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'resources/read',
      params: {
        uri: configTemplateUri,
      },
    }),
  });

  assert.equal(readResource.status, 200);
  const readResourceBody = await readResource.json();
  assert.equal(readResourceBody.id, 4);
  assert(Array.isArray(readResourceBody.result.contents));
  assert.equal(readResourceBody.result.contents[0].uri, configTemplateUri);
  assert.match(
    readResourceBody.result.contents[0].mimeType ?? '',
    /^text\/html;profile=mcp-app$/i,
  );
  assert(
    typeof readResourceBody.result.contents[0].text === 'string' &&
      readResourceBody.result.contents[0].text.length > 100,
    'resources/read must return the packaged MCP App HTML template',
  );

  const listResourceTemplates = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      ...commonHeaders,
      'mcp-protocol-version': initializeBody.result.protocolVersion,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/templates/list',
      params: {},
    }),
  });

  assert.equal(listResourceTemplates.status, 200);
  const listResourceTemplatesBody = await listResourceTemplates.json();
  assert.equal(listResourceTemplatesBody.id, 5);
  assert(Array.isArray(listResourceTemplatesBody.result.resourceTemplates));

  const getMcp = await fetch(`${base}/mcp`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
    },
  });
  assert.equal(getMcp.status, 405);
  assert.equal(getMcp.headers.get('allow'), 'POST');

  const finalHealth = await fetch(`${base}/health`);
  assert.equal(finalHealth.status, 200);
  const finalHealthBody = await finalHealth.json();
  assert.equal(finalHealthBody.activeMcpRequests, 0);

  console.log('PASS self-host stateless JSON transport');
} catch (error) {
  console.error(stderr);
  throw error;
} finally {
  await stopChild(child);
}
