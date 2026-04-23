/**
 * Live diagnostic: does imageBlock() actually produce a valid image
 * content block when run against the real Rewind CDN? No mocks.
 *
 * Run: npx tsx src/__tests__/image-block.live.ts
 */
import { RewindClient } from '../client.js';
import { imageBlock } from '../tools/helpers.js';

const FIXTURE = {
  movieId: 710,
  title: "I'm Chevy Chase and You're Not",
  cdn_url:
    'https://cdn.rewind.rest/watching/movies/710/original.jpg?width=300&height=300&fit=cover&format=auto&quality=85&v=1',
};

async function main() {
  // Base URL + api key are irrelevant here -- imageBlock goes through
  // getBinaryFromUrl which hits the full CDN URL without auth.
  const client = new RewindClient('https://api.rewind.rest', 'rw_unused');

  console.log(`Testing imageBlock against live CDN...`);
  console.log(`Fixture: ${FIXTURE.title} (movie ${FIXTURE.movieId})`);
  console.log(`URL: ${FIXTURE.cdn_url}\n`);

  const start = Date.now();
  const block = await imageBlock(client, { cdn_url: FIXTURE.cdn_url });
  const ms = Date.now() - start;

  if (!block) {
    console.error(`FAIL: imageBlock returned null (fetched in ${ms}ms)`);
    process.exit(1);
  }

  console.log(`SUCCESS (${ms}ms)`);
  console.log(`- type:      ${block.type}`);
  console.log(`- mimeType:  ${block.mimeType}`);
  console.log(`- data size: ${block.data.length} base64 chars`);
  console.log(`- sniff:     ${block.data.slice(0, 24)}...`);
  // JPEG base64 starts with /9j/
  const looksLikeJpeg = block.data.startsWith('/9j/');
  console.log(
    `- JPEG?      ${looksLikeJpeg ? 'yes (starts with /9j/)' : 'NO -- unexpected'}`
  );
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
