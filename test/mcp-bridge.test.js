// The bridge to the MCP servers of mcp.json: a real MCP server over stdio is
// started, the tools are read and one of them is called.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxframe-mcp-'));
process.env.DATA_DIR = dir;
process.env.WORKSPACE_DIR = dir;

// A small MCP server over stdio. It lives inside the project, so that node
// resolves the SDK from node_modules.
const projectRoot = process.cwd();
const serverFile = path.join(projectRoot, 'data', 'test-mcp-server.mjs');
fs.mkdirSync(path.dirname(serverFile), { recursive: true });
fs.writeFileSync(serverFile, `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'echo-server', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Возвращает текст обратно',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: 'echo: ' + req.params.arguments.text }],
}));
await server.connect(new StdioServerTransport());
`);

const mcpFile = path.join(dir, 'mcp.json');
fs.writeFileSync(mcpFile, JSON.stringify({
  mcpServers: {
    echo: { command: process.execPath, args: [serverFile], cwd: projectRoot },
  },
}));
process.env.MCP_CONFIG = mcpFile;

const { mcpTools, closeMcp } = await import('../src/mcp.js');

after(async () => {
  await closeMcp();
});

test('the tools of an MCP server are read', async () => {
  const tools = await mcpTools();
  const echo = tools.find((t) => t.name === 'mcp__echo__echo');
  assert.ok(echo, 'инструмент MCP-сервера должен появиться в списке');
  assert.equal(echo.description, 'Возвращает текст обратно');
  assert.equal(echo.parameters.properties.text.type, 'string');
});

test('an MCP tool is called and its answer comes back', async () => {
  const tools = await mcpTools();
  const echo = tools.find((t) => t.name === 'mcp__echo__echo');
  const out = await echo.handler({ text: 'привет' });
  assert.match(String(out), /echo: привет/);
});
