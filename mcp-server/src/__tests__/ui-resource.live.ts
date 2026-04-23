/**
 * Probe the deployed UI resource via stdio. Connects to the built binary,
 * lists resources, fetches ui://rewind/recent-watches.html, and prints the
 * response shape so we can see exactly what Claude Desktop receives.
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

  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
    env: { ...process.env, REWIND_API_KEY: process.env.REWIND_API_KEY },
  });

  const client = new Client({ name: 'ui-resource-probe', version: '1.0.0' });
  await client.connect(transport);

  console.log('=== resources/list ===');
  const list = await client.listResources();
  for (const r of list.resources) {
    console.log(`  ${r.uri}  (${r.mimeType ?? 'no mime'})  "${r.name}"`);
  }
  console.log(
    `  [+${list.resources.length === 0 ? 0 : list.resources.length} static resources]`
  );

  console.log('\n=== resources/templates/list ===');
  const templates = await client.listResourceTemplates();
  for (const t of templates.resourceTemplates) {
    console.log(`  ${t.uriTemplate}  "${t.name}"`);
  }

  console.log('\n=== resources/read ui://rewind/recent-watches.html ===');
  try {
    const read = await client.readResource({
      uri: 'ui://rewind/recent-watches.html',
    });
    for (const c of read.contents) {
      console.log(`  uri:      ${c.uri}`);
      console.log(`  mimeType: ${c.mimeType}`);
      const text =
        'text' in c && typeof c.text === 'string' ? c.text : undefined;
      if (text) {
        console.log(`  size:     ${text.length} chars`);
        console.log(`  preview:  ${text.slice(0, 160).replace(/\n/g, ' / ')}…`);
      }
      const meta = (c as { _meta?: unknown })._meta;
      console.log(`  _meta:    ${meta ? JSON.stringify(meta) : '(absent)'}`);
    }
  } catch (err) {
    console.error(
      'read failed:',
      err instanceof Error ? err.message : String(err)
    );
  }

  console.log('\n=== tools/list (check get_recent_watches _meta) ===');
  const tools = await client.listTools();
  const grw = tools.tools.find((t) => t.name === 'get_recent_watches');
  if (grw) {
    console.log('  found get_recent_watches');
    console.log(
      `  _meta: ${JSON.stringify((grw as { _meta?: unknown })._meta ?? 'absent')}`
    );
  } else {
    console.log('  NOT FOUND');
  }

  await client.close();
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
