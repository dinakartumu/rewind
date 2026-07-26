import { describe, it, expect } from 'vitest';
import wranglerToml from '../../wrangler.toml?raw';
import indexSource from '../index.ts?raw';

/**
 * Cron dispatch is a string match: Cloudflare hands `scheduled()` the trigger
 * expression verbatim from wrangler.toml, and the handler switches on it. So a
 * trigger and its case label are two independent spellings of the same string,
 * with nothing tying them together and no runtime signal when they disagree —
 * an unmatched trigger just falls through to `default:` and logs.
 *
 * That is how the collecting domain went its entire life without syncing once:
 * wrangler.toml registered "45 3 * * SUN" while the handler matched
 * "45 3 * * 0". Both are valid cron for Sunday; neither equals the other.
 * See issue #18.
 *
 * These tests read both files as text rather than importing a shared constant,
 * because the whole failure mode is the absence of a shared constant. A test
 * that asserted against something both sides imported could not catch it.
 */

function registeredCrons(toml: string): string[] {
  const block = toml.match(/^crons\s*=\s*\[([\s\S]*?)\]/m);
  if (!block) throw new Error('No crons array found in wrangler.toml');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function handledCrons(source: string): string[] {
  const scheduled = source.slice(source.indexOf('async scheduled('));
  return [...scheduled.matchAll(/case\s+'([^']+)':/g)].map((m) => m[1]);
}

describe('cron wiring', () => {
  const registered = registeredCrons(wranglerToml);
  const handled = handledCrons(indexSource);

  it('parses both sides (guards against the regexes silently matching nothing)', () => {
    expect(registered.length).toBeGreaterThan(0);
    expect(handled.length).toBeGreaterThan(0);
  });

  it('every registered trigger has a handler case', () => {
    const missing = registered.filter((c) => !handled.includes(c));
    expect(
      missing,
      `triggers registered but never handled: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('every handler case has a registered trigger', () => {
    const orphaned = handled.filter((c) => !registered.includes(c));
    expect(
      orphaned,
      `handler cases that can never fire: ${orphaned.join(', ')}`
    ).toEqual([]);
  });
});
