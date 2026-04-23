/**
 * Live end-to-end: spawn the built dist/index.js as a subprocess,
 * speak MCP over stdio, call real tools against the real API, and
 * inspect the response content blocks.
 *
 * Usage: REWIND_API_KEY=<key> npx tsx src/__tests__/stdio-e2e.live.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, '../../dist/index.js');

async function main() {
  if (!process.env.REWIND_API_KEY) {
    console.error('REWIND_API_KEY required');
    process.exit(1);
  }

  console.log(`Spawning: node ${serverPath}\n`);

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, REWIND_API_KEY: process.env.REWIND_API_KEY },
  });

  const client = new Client({ name: 'stdio-e2e', version: '1.0.0' });
  await client.connect(transport);

  // Call both with and without structuredContent to confirm both modes work.
  for (const debugFlag of [false, true]) {
    console.log(
      `\n=== Call: get_movie_details(id=707, _debug_no_structured=${debugFlag}) ===`
    );
    const result = await client.callTool({
      name: 'get_movie_details',
      arguments: {
        id: 707,
        include_images: true,
        _debug_no_structured: debugFlag,
      },
    });

    const content = result.content as Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    const sc = (result as { structuredContent?: unknown }).structuredContent;

    console.log(`content blocks (${content.length}):`);
    for (const block of content) {
      if (block.type === 'text') {
        console.log(`  - text: ${(block.text ?? '').slice(0, 80)}...`);
      } else if (block.type === 'image') {
        console.log(
          `  - image: ${block.mimeType}, ${(block.data ?? '').length} base64 chars`
        );
      } else {
        console.log(`  - ${block.type}`);
      }
    }
    console.log(`structuredContent: ${sc ? 'present' : 'absent'}`);
  }

  await client.close();
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
