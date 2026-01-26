import { importMcpSdk } from '../shared/sdk-loader.mjs';
import { errorResult, okResult } from '../shared/mcp-result.mjs';
import {
  EXEC_TOOL_NAME,
  ToolError,
  getExecToolDefinition,
  parseExecToolInput,
  runExecTool,
} from './core.mjs';

const { Server } = await importMcpSdk('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await importMcpSdk('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = await importMcpSdk(
  '@modelcontextprotocol/sdk/types.js',
);

const server = new Server(
  { name: 'librechat-exec-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [getExecToolDefinition()],
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  if (request.params.name !== EXEC_TOOL_NAME) {
    return errorResult('UNKNOWN_TOOL', `Unknown tool: ${request.params.name}`);
  }

  try {
    const input = parseExecToolInput(request.params.arguments);
    const result = await runExecTool(input, { signal: extra?.signal });
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
