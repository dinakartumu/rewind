/**
 * Shared "top-N per period, rest into Other" bucketer for the per-month
 * breakdown endpoints (listening genres, watching genres, places categories).
 * Takes rows of `{ period, name, count }` (already grouped in SQL) and returns
 * one entry per period with the top `limit` names kept, everything else folded
 * into a single "Other" key, plus the period total. Periods are returned in
 * ascending chronological order.
 */
export function bucketByPeriod(
  rows: Array<{ period: string | null; name: string | null; count: number }>,
  limit: number
): Array<{ period: string; items: Record<string, number>; total: number }> {
  const map = new Map<
    string,
    { items: Record<string, number>; total: number }
  >();
  for (const r of rows) {
    if (!r.period || !r.name) continue;
    let entry = map.get(r.period);
    if (!entry) {
      entry = { items: {}, total: 0 };
      map.set(r.period, entry);
    }
    entry.items[r.name] = (entry.items[r.name] || 0) + r.count;
    entry.total += r.count;
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, { items, total }]) => {
      const sorted = Object.entries(items).sort(([, a], [, b]) => b - a);
      const top: Record<string, number> = {};
      let other = 0;
      sorted.forEach(([name, cnt], i) => {
        if (i < limit) top[name] = cnt;
        else other += cnt;
      });
      if (other > 0) top['Other'] = other;
      return { period, items: top, total };
    });
}
