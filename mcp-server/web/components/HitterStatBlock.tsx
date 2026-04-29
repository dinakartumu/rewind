import type { CSSProperties } from 'react';

/**
 * Curated hitter hero block. Used for both "season" and "attended"
 * surfaces so the comparison reads parallel — same fields, same order,
 * same hierarchy. Each stat sits in its own boxed cell so the four
 * numbers stop blending together; matches the visual language of the
 * splits grid above it on the same card.
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
  // season_stats.hitter has games_played; attended uses
  // attended_summary.games_attended. Decoupling keeps the component
  // free of surface-specific knowledge.
  games?: number;
  tint: string;
}) {
  const cells: Array<[string, string]> = [
    ['AVG', stats.avg ?? '—'],
    ['HR', fmt(stats.hr)],
    ['RBI', fmt(stats.rbi)],
    ['OPS', stats.ops ?? '—'],
  ];

  const contextParts: string[] = [];
  if (games != null) contextParts.push(`${fmt(games)} G`);
  if (stats.pa != null) contextParts.push(`${fmt(stats.pa)} PA`);
  if (stats.ab != null && stats.h != null) {
    contextParts.push(`${fmt(stats.h)}/${fmt(stats.ab)}`);
  }
  const context = contextParts.join(' · ');

  return (
    <section style={blockStyle}>
      <div style={headerStyle}>
        <span>{title}</span>
        {trailing && <span style={trailingStyle}>{trailing}</span>}
      </div>
      <div style={gridStyle}>
        {cells.map(([label, value]) => (
          <div key={label} style={cellStyle}>
            <div style={labelStyle}>{label}</div>
            <div style={{ ...valueStyle, color: tint }}>{value}</div>
          </div>
        ))}
      </div>
      {context && <div style={contextStyle}>{context}</div>}
    </section>
  );
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '0';
  return n.toLocaleString();
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
  paddingLeft: 2,
};

const trailingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  letterSpacing: 0.4,
  opacity: 0.7,
  textTransform: 'none',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, 1fr)',
  gap: 8,
};

const cellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  borderRadius: 10,
  background: 'rgba(127,127,127,0.06)',
};

const labelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  opacity: 0.55,
};

const valueStyle: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  lineHeight: 1.05,
  fontVariantNumeric: 'tabular-nums',
  letterSpacing: -0.4,
};

const contextStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.6,
  fontVariantNumeric: 'tabular-nums',
  paddingLeft: 2,
};
