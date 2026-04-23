import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';

export type Watch = {
  movie: {
    id: number;
    title: string;
    year: number | null;
    director: string | null;
    image: {
      cdn_url?: string | null;
      url?: string | null;
      thumbhash?: string | null;
      dominant_color?: string | null;
      accent_color?: string | null;
    } | null;
  };
  watched_at: string;
  user_rating: number | null;
  rewatch: boolean;
  review_url: string | null;
};

export function PosterCard({
  watch,
  onOpen,
}: {
  watch: Watch;
  onOpen?: (url: string) => void;
}) {
  const { movie, user_rating, rewatch, review_url } = watch;
  const posterUrl = movie.image?.cdn_url ?? movie.image?.url ?? null;
  const placeholder = thumbhashToDataUrl(movie.image?.thumbhash ?? null);
  const dominant = movie.image?.dominant_color ?? '#222';

  const [loaded, setLoaded] = useState(false);
  const [hovered, setHovered] = useState(false);

  const clickable = review_url != null;
  const Tag: 'button' | 'div' = clickable ? 'button' : 'div';

  return (
    <Tag
      type={clickable ? 'button' : undefined}
      onClick={clickable && review_url ? () => onOpen?.(review_url) : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...cardStyle,
        cursor: clickable ? 'pointer' : 'default',
        transform: hovered ? 'translateY(-2px)' : 'translateY(0)',
        // Subtle ring that reads on both light and dark themes. The host's
        // `--color-border-*` vars are theme-aware; the rgba fallback uses
        // `currentColor` via a mid-grey so it's visible on either background.
        boxShadow: hovered ? hoverShadow : restShadow,
      }}
      aria-label={
        clickable ? `Open Letterboxd review for ${movie.title}` : movie.title
      }
    >
      <div
        style={{
          position: 'relative',
          aspectRatio: '2 / 3',
          background: dominant,
        }}
      >
        {placeholder && (
          <img
            src={placeholder}
            alt=""
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              filter: 'blur(12px)',
              transform: 'scale(1.05)',
              opacity: loaded ? 0 : 1,
              transition: 'opacity 180ms ease',
            }}
          />
        )}
        {posterUrl && (
          <img
            src={posterUrl}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              opacity: loaded ? 1 : 0,
              transition: 'opacity 200ms ease',
            }}
          />
        )}
        {rewatch && <span style={badgeStyle('top-left')}>rewatch</span>}
        {user_rating !== null && (
          <span style={badgeStyle('top-right')}>
            {formatRating(user_rating)}
          </span>
        )}
      </div>
      <div style={metaStyle}>
        <div style={titleStyle}>{movie.title}</div>
        <div style={subStyle}>
          {movie.year ? `${movie.year}` : ''}
          {movie.year && movie.director ? ' · ' : ''}
          {movie.director ?? ''}
        </div>
      </div>
    </Tag>
  );
}

function formatRating(r: number): string {
  const display = r % 1 === 0 ? r.toFixed(0) : r.toFixed(1);
  return `${display}★`;
}

// Theme-aware border + background via host-provided CSS variables. When
// Claude Desktop runs in dark mode, `--color-background-secondary` and
// `--color-border-primary` resolve to dark-theme values; in light mode
// they resolve to light values. The rgba fallbacks are picked to be
// readable against both typical chat backgrounds.
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 8,
  overflow: 'hidden',
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.15))',
  background: 'var(--color-background-secondary, transparent)',
  textAlign: 'left',
  padding: 0,
  font: 'inherit',
  color: 'inherit',
  transition: 'transform 150ms ease, box-shadow 150ms ease',
  willChange: 'transform',
};

// Two-layer shadows at low alpha read on light backgrounds; on dark
// backgrounds the border + background-secondary do the visual separation.
const restShadow = '0 1px 2px rgba(0,0,0,0.08), 0 2px 8px rgba(0,0,0,0.12)';
const hoverShadow = '0 4px 10px rgba(0,0,0,0.18), 0 8px 24px rgba(0,0,0,0.18)';

const metaStyle: CSSProperties = {
  padding: '8px 10px 10px',
  fontSize: 12,
  lineHeight: 1.3,
};

const titleStyle: CSSProperties = {
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const subStyle: CSSProperties = {
  opacity: 0.6,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function badgeStyle(pos: 'top-left' | 'top-right'): CSSProperties {
  return {
    position: 'absolute',
    top: 6,
    [pos === 'top-left' ? 'left' : 'right']: 6,
    background: 'rgba(0,0,0,0.65)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  };
}
