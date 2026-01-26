import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { importMcpSdk } from '../shared/sdk-loader.mjs';

const { Client } = await importMcpSdk('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = await importMcpSdk(
  '@modelcontextprotocol/sdk/client/stdio.js',
);

function getMcpRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

async function withClient(serverPath, fn) {
  const client = new Client(
    { name: 'librechat-mcp-self-check', version: '0.1.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...getDefaultEnvironment(), ...process.env },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function parseJsonTextResult(result) {
  assert.ok(result);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

async function checkExecServer(mcpRoot) {
  const execServer = path.join(mcpRoot, 'exec-server', 'index.mjs');
  await withClient(execServer, async (client) => {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'exec'));

    const okRes = await client.callTool({
      name: 'exec',
      arguments: { command: 'node', args: ['-v'], timeoutMs: 30_000 },
    });
    assert.equal(okRes.isError ?? false, false);
    const okJson = parseJsonTextResult(okRes);
    assert.equal(okJson.ok, true);
    assert.equal(okJson.exitCode, 0);
    assert.equal(typeof okJson.stdout, 'string');

    const badCmd = await client.callTool({
      name: 'exec',
      arguments: { command: 'bash', args: ['-lc', 'echo nope'] },
    });
    assert.equal(badCmd.isError, true);

    const badGit = await client.callTool({
      name: 'exec',
      arguments: { command: 'git', args: ['-C', '/'] },
    });
    assert.equal(badGit.isError, true);
  });
}

async function checkFetchServer(mcpRoot) {
  const fetchServer = path.join(mcpRoot, 'fetch-server', 'index.mjs');
  await withClient(fetchServer, async (client) => {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'fetch'));

    const blocked = await client.callTool({
      name: 'fetch',
      arguments: { url: 'http://127.0.0.1' },
    });
    assert.equal(blocked.isError, true);

    const okRes = await client.callTool({
      name: 'fetch',
      arguments: { url: 'https://example.com', timeoutMs: 15_000, maxBytes: 200_000 },
    });
    assert.equal(okRes.isError ?? false, false);
    const okJson = parseJsonTextResult(okRes);
    assert.equal(okJson.ok, true);
    assert.equal(okJson.status, 200);
    assert.ok(typeof okJson.body === 'string');
    assert.ok(okJson.body.toLowerCase().includes('example domain'));
  });
}

const mcpRoot = getMcpRoot();
await checkExecServer(mcpRoot);
await checkFetchServer(mcpRoot);

