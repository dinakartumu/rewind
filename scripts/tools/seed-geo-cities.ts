/**
 * GeoNames geo_cities Seed Script
 *
 * Builds a SQL seed file for the geo_cities reverse-geocoding reference
 * table from the GeoNames cities15000 dump (~33k cities with population
 * >= 15,000). Admin1 codes (state/region) are resolved to readable names
 * via admin1CodesASCII.txt.
 *
 * The output is a single .sql file (DELETE + chunked multi-row INSERTs,
 * 500 rows per statement) suitable for `wrangler d1 execute --file`.
 *
 * Prerequisites: `unzip` on PATH (macOS/Linux default).
 *
 * Usage:
 *   npx tsx scripts/tools/seed-geo-cities.ts                 # downloads both dumps
 *   npx tsx scripts/tools/seed-geo-cities.ts cities15000.zip # local zip or .txt
 *   npx tsx scripts/tools/seed-geo-cities.ts --out ./seed    # custom output dir
 *
 * Then apply:
 *   npx wrangler d1 execute rewind-db --local --file <printed path>
 *   npx wrangler d1 execute rewind-db --remote --file <printed path>
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CITIES_URL = 'https://download.geonames.org/export/dump/cities15000.zip';
const ADMIN1_URL =
  'https://download.geonames.org/export/dump/admin1CodesASCII.txt';
const ROWS_PER_STATEMENT = 500;

// --- Args ---

const args = process.argv.slice(2);
let localCitiesPath: string | null = null;
let outDir: string | null = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') {
    outDir = args[++i] ?? null;
  } else if (!args[i].startsWith('--')) {
    localCitiesPath = args[i];
  }
}

// --- Fetch helpers ---

async function download(url: string, dest: string): Promise<void> {
  console.log(`[INFO] Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function readCitiesTsv(pathToZipOrTxt: string): string {
  if (pathToZipOrTxt.endsWith('.txt')) {
    return readFileSync(pathToZipOrTxt, 'utf-8');
  }
  // cities15000.txt inside the zip; ~10 MB uncompressed
  return execFileSync('unzip', ['-p', pathToZipOrTxt, 'cities15000.txt'], {
    encoding: 'utf-8',
    maxBuffer: 128 * 1024 * 1024,
  });
}

// --- Main ---

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), 'rewind-geo-'));

  let citiesPath: string;
  if (localCitiesPath) {
    citiesPath = resolve(localCitiesPath);
    console.log(`[INFO] Using local cities dump: ${citiesPath}`);
  } else {
    citiesPath = join(workDir, 'cities15000.zip');
    await download(CITIES_URL, citiesPath);
  }

  const admin1Path = join(workDir, 'admin1CodesASCII.txt');
  await download(ADMIN1_URL, admin1Path);

  // admin1CodesASCII.txt: "US.OR\tOregon\tOregon\t5744337"
  const admin1Names = new Map<string, string>();
  for (const line of readFileSync(admin1Path, 'utf-8').split('\n')) {
    const [code, name] = line.split('\t');
    if (code && name) admin1Names.set(code.trim(), name.trim());
  }
  console.log(`[INFO] Loaded ${admin1Names.size} admin1 code mappings`);

  // cities15000.txt fields (tab-separated):
  //   0 geonameid, 1 name, 4 latitude, 5 longitude,
  //   8 country code, 10 admin1 code
  const rows: string[] = [];
  let skipped = 0;
  for (const line of readCitiesTsv(citiesPath).split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const id = Number(fields[0]);
    const name = fields[1];
    const lat = Number(fields[4]);
    const lng = Number(fields[5]);
    const countryCode = fields[8];
    const admin1Code = fields[10];

    if (
      !Number.isInteger(id) ||
      !name ||
      !countryCode ||
      Number.isNaN(lat) ||
      Number.isNaN(lng)
    ) {
      skipped++;
      continue;
    }

    const admin1 = admin1Names.get(`${countryCode}.${admin1Code}`) ?? null;
    const esc = (s: string) => s.replace(/'/g, "''");
    rows.push(
      `(${id}, '${esc(name)}', ${admin1 ? `'${esc(admin1)}'` : 'NULL'}, '${esc(countryCode)}', ${lat}, ${lng})`
    );
  }

  if (rows.length === 0) {
    throw new Error('No city rows parsed - is the input a GeoNames dump?');
  }

  // Chunked multi-row INSERTs as plain literals (no bound params, so the
  // D1 parameter limit does not apply; 500 rows/statement keeps each
  // statement comfortably sized).
  const statements: string[] = ['DELETE FROM geo_cities;'];
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(i, i + ROWS_PER_STATEMENT);
    statements.push(
      `INSERT INTO geo_cities (id, name, admin1, country_code, lat, lng) VALUES\n${chunk.join(',\n')};`
    );
  }

  const targetDir = outDir ? resolve(outDir) : workDir;
  mkdirSync(targetDir, { recursive: true });
  const sqlPath = join(targetDir, 'seed-geo-cities.sql');
  writeFileSync(sqlPath, statements.join('\n'));

  console.log(
    `[INFO] Wrote ${rows.length} cities (${skipped} skipped) in ${statements.length} statements`
  );
  console.log(`[INFO] Seed file: ${sqlPath}`);
  console.log('[INFO] Apply with:');
  console.log(
    `[INFO]   npx wrangler d1 execute rewind-db --local --file ${sqlPath}`
  );
  console.log(
    `[INFO]   npx wrangler d1 execute rewind-db --remote --file ${sqlPath}`
  );
}

main().catch((error) => {
  console.error(`[ERROR] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
