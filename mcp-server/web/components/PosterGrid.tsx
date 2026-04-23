import type { CSSProperties } from 'react';
import { PosterCard, type Watch } from './PosterCard.js';

export function PosterGrid({
  items,
  onOpen,
}: {
  items: Watch[];
  onOpen?: (url: string) => void;
}) {
  if (!items.length) {
    return <div style={emptyStyle}>No watches in the selected window.</div>;
  }

  return (
    <div style={gridStyle}>
      {items.map((w, i) => (
        <PosterCard
          key={`${w.movie.id}-${w.watched_at}-${i}`}
          watch={w}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns:
    'repeat(auto-fill, minmax(clamp(120px, 20vw, 180px), 1fr))',
  gap: 12,
  padding: 12,
};

const emptyStyle: CSSProperties = {
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
