import { describe, it, expect } from 'vitest';
import { isTable, getTableName } from 'drizzle-orm';
import {
  SCHEMA_DOC,
  schemaDocTableNames,
  allowedTableNames,
} from './schema-doc.js';
import { DENIED_TABLES, ALLOWED_TABLES } from './sql-guard.js';

// Import every schema module. Enumerating the exported Drizzle table objects
// (rather than parsing source files) is the source of truth that survives the
// Workers test sandbox and can't drift from the actual schema. Any NEW schema
// file must be added here — but a new *table* in an existing file is picked up
// automatically, which is the drift this coverage test is meant to catch.
import * as attending from '../db/schema/attending.js';
import * as discogs from '../db/schema/discogs.js';
import * as geo from '../db/schema/geo.js';
import * as google from '../db/schema/google.js';
import * as lastfm from '../db/schema/lastfm.js';
import * as places from '../db/schema/places.js';
import * as reading from '../db/schema/reading.js';
import * as strava from '../db/schema/strava.js';
import * as system from '../db/schema/system.js';
import * as trakt from '../db/schema/trakt.js';
import * as watching from '../db/schema/watching.js';
import * as wakatime from '../db/schema/wakatime.js';
import * as rescuetime from '../db/schema/rescuetime.js';
import * as github from '../db/schema/github.js';

const schemaModules = [
  attending,
  discogs,
  geo,
  google,
  lastfm,
  places,
  reading,
  strava,
  system,
  trakt,
  watching,
  wakatime,
  rescuetime,
  github,
];

/** Every physical table name defined across the Drizzle schema modules. */
function allSchemaTables(): string[] {
  const names = new Set<string>();
  for (const mod of schemaModules) {
    for (const value of Object.values(mod)) {
      if (isTable(value)) names.add(getTableName(value));
    }
  }
  return [...names];
}

describe('schema-doc coverage', () => {
  it('parsed a plausible number of tables from the schema files', () => {
    // Guard against the parser silently matching nothing.
    expect(allSchemaTables().length).toBeGreaterThan(30);
  });

  it('documents every ALLOWED table (fails when a new table is undocumented)', () => {
    const documented = new Set(schemaDocTableNames());
    const denied = new Set(DENIED_TABLES);
    const missing: string[] = [];

    for (const table of allSchemaTables()) {
      if (denied.has(table)) continue;
      // *_tokens tables are denied by convention even if not explicitly listed.
      if (table.endsWith('_tokens')) continue;
      if (!documented.has(table)) missing.push(table);
    }

    expect(
      missing,
      `Undocumented allowed tables — add them to SCHEMA_DOC: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('does NOT document any denied table', () => {
    const documented = new Set(schemaDocTableNames());
    const leaked: string[] = [];
    for (const table of DENIED_TABLES) {
      if (documented.has(table)) leaked.push(table);
    }
    // Also assert no *_tokens table snuck in.
    for (const name of documented) {
      if (name.endsWith('_tokens')) leaked.push(name);
    }
    expect(
      leaked,
      `Denied tables leaked into SCHEMA_DOC: ${leaked.join(', ')}`
    ).toEqual([]);
  });

  it('every documented table has at least one column', () => {
    for (const table of SCHEMA_DOC.tables) {
      expect(
        table.columns.length,
        `table ${table.name} has no columns`
      ).toBeGreaterThan(0);
    }
  });

  it('has no duplicate table entries', () => {
    const names = schemaDocTableNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it('ALLOWED_TABLES is exactly the documented set (lower-cased)', () => {
    const expected = new Set(schemaDocTableNames().map((n) => n.toLowerCase()));
    // Same helper the guard consumes.
    expect(new Set(allowedTableNames())).toEqual(expected);
    // The guard's frozen set matches the documented set exactly — no more, no
    // less. This makes SCHEMA_DOC the single source of truth for the gate.
    expect(new Set(ALLOWED_TABLES)).toEqual(expected);
    expect(ALLOWED_TABLES.size).toBe(schemaDocTableNames().length);
  });

  it('no denied table is in the allow-list', () => {
    for (const denied of DENIED_TABLES) {
      expect(ALLOWED_TABLES.has(denied.toLowerCase())).toBe(false);
    }
  });

  it('includes the global orientation notes a model needs', () => {
    const notes = SCHEMA_DOC.notes.join('\n').toLowerCase();
    expect(notes).toContain('user_id');
    expect(notes).toContain('cdn.dinakartumu.com');
    expect(notes).toContain('is_filtered');
    // Rating scales and ISO timestamps are called out.
    expect(notes).toMatch(/rating/);
    expect(notes).toMatch(/iso/);
  });
});
