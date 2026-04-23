/**
 * Debug tools for MCP Apps pipeline verification. Throwaway -- will be
 * removed once Phase 2 stabilizes.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { READ_ONLY_ANNOTATIONS } from './helpers.js';

export function registerDebugTools(server: McpServer): void {
  server.registerTool(
    'ui_hello_debug',
    {
      title: 'UI Hello (debug)',
      description:
        'Show the Rewind MCP Apps diagnostic UI. Invoke this to verify the MCP Apps pipeline end-to-end against a known-working minimal React app.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ui: { resourceUri: 'ui://rewind/hello.html' },
        'ui/resourceUri': 'ui://rewind/hello.html',
      },
    },
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: 'Rewind MCP Apps diagnostic. If the UI renders inline, the MCP Apps pipeline is working; if it fails with "Failed to set up MCP app", the issue is client-side (Anthropic sandbox).',
        },
      ],
      structuredContent: {
        greeting: 'hello',
        server_time: new Date().toISOString(),
        app: 'rewind-hello',
      },
    })
  );
}
