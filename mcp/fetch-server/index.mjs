import { importMcpSdk } from '../shared/sdk-loader.mjs';
import { errorResult, okResult } from '../shared/mcp-result.mjs';
import {
  FETCH_TOOL_NAME,
  ToolError,
  fetchWithGuards,
  getFetchToolDefinition,
  parseFetchToolInput,
} from './core.mjs';

const { Server } = await importMcpSdk('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await importMcpSdk('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = await importMcpSdk(
  '@modelcontextprotocol/sdk/types.js',
);

const server = new Server(
  { name: 'librechat-fetch-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [getFetchToolDefinition()],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== FETCH_TOOL_NAME) {
    return errorResult('UNKNOWN_TOOL', `Unknown tool: ${request.params.name}`);
  }

  try {
    const input = parseFetchToolInput(request.params.arguments);
    const result = await fetchWithGuards(input, { signal: extra?.signal });
    return okResult(result);
  } catch (error) {
    if (error instanceof ToolError) {
      return errorResult(error.code, error.message, error.details);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult('INTERNAL_ERROR', message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
