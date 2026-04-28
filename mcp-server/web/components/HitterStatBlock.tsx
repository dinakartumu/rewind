import type { CSSProperties } from 'react';

/**
 * Curated hitter hero block. Used for both "season" and "attended"
 * surfaces so the comparison reads parallel — same fields, same order,
 * same hierarchy. The ESPN-style headline four (AVG / HR / RBI / OPS)
 * sit on top; G + PA hang below as sample-size context.
 *
 * The shape is the loose intersection of `season_stats.hitter` and
 * `attended_summary.hitter` after the 2026-04 alignment — both surfaces
 * carry games_played-or-equivalent + PA + the slash + counting numbers.
 */
type Hitter = {
  games_played?: number;
  pa?: number | null;
  ab?: number | null;
  h?: number | null;
  hr?: number | null;
  rbi?: number | null;
  avg?: string | null;
  ops?: string | null;
};

export function HitterStatBlock({
  title,
  trailing,
  stats,
  games,
  tint,
}: {
  title: string;
  trailing?: string;
  stats: Hitter;
  // Caller passes whichever "games" makes sense for this scope —
  // season_stats.hitter has `games_played`; attended uses
  // `attended_summary.games_attended`. Decoupling keeps the component
  // free of surface-specific knowledge.
  games?: number;
  tint: string;
}) {
  return (
    <section style={blockStyle}>
      <div style={headerStyle}>
        <span>{title}</span>
        {trailing && <span style={trailingStyle}>{trailing}</span>}
      </div>
      <div style={bigFourStyle}>
        <Stat label="AVG" value={stats.avg ?? '—'} tint={tint} />
        <Stat label="HR" value={fmt(stats.hr)} tint={tint} />
        <Stat label="RBI" value={fmt(stats.rbi)} tint={tint} />
        <Stat label="OPS" value={stats.ops ?? '—'} tint={tint} />
      </div>
      <div style={contextStyle}>
        {games != null && <span>{fmt(games)} G</span>}
        {stats.pa != null && <span>{fmt(stats.pa)} PA</span>}
        {stats.ab != null && stats.h != null && (
          <span>
            {fmt(stats.h)}/{fmt(stats.ab)}
          </span>
        )}
      </div>
    </section>
  );
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
}

function Stat({
  label,
  value,
  tint,
}: {
  label: string;
  value: string;
  tint: string;
}) {
  return (
    <div style={cellStyle}>
      <div style={{ ...valueStyle, color: tint }}>{value}</div>
      <div style={labelStyle}>{label}</div>
    </div>
  );
}

const blockStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const headerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const trailingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.4,
  opacity: 0.7,
  textTransform: 'none',
};

const bigFourStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
};

const cellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
};

const valueStyle: CSSProperties = {
  fontSize: 32,
  fontWeight: 700,
  lineHeight: 1,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -0.5,
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const contextStyle: CSSProperties = {
  display: 'flex',
  gap: 14,
  fontSize: 11,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
  paddingTop: 2,
};
