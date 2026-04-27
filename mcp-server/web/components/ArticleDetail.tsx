import { useState, type CSSProperties } from 'react';
import { thumbhashToDataUrl } from '../lib/thumbhash.js';
import { timeAgo } from '../lib/time-ago.js';

type Image = {
  cdn_url?: string | null;
  url?: string | null;
  thumbhash?: string | null;
  dominant_color?: string | null;
  accent_color?: string | null;
} | null;

export type ArticleMeta = {
  id: number;
  title: string;
  author: string | null;
  url: string | null;
  instapaper_url: string | null;
  instapaper_app_url: string | null;
  domain: string | null;
  description: string | null;
  word_count: number | null;
  estimated_read_min: number | null;
  status: string;
  progress: number;
  saved_at: string;
  image: Image;
};

export type Highlight = {
  id: number;
  text: string;
  note: string | null;
  created_at: string;
};

export type ArticlePayload = {
  article: ArticleMeta;
  highlights: Highlight[];
  highlight_count: number;
};

const HERO_W = 720;
const HERO_H = 405; // 16:9
const CDN_TRANSFORM = `width=${HERO_W * 2},height=${HERO_H * 2},fit=cover,format=auto,quality=85`;

function buildHeroSrc(
  image: Image
): { src: string; placeholder: string | null } | null {
  if (!image) return null;
  const base = image.cdn_url ?? image.url ?? null;
  if (!base) return null;
  const transformed = base.includes('?')
    ? `${base.split('?')[0]}?${CDN_TRANSFORM}`
    : `${base}?${CDN_TRANSFORM}`;
  return {
    src: transformed,
    placeholder: thumbhashToDataUrl(image.thumbhash ?? null),
  };
}

function statusLabel(status: string): { text: string; tone: StatusTone } {
  switch (status) {
    case 'archived':
      return { text: 'Archived', tone: 'subdued' };
    case 'starred':
      return { text: 'Starred', tone: 'accent' };
    case 'reading':
      return { text: 'Reading', tone: 'active' };
    case 'unread':
      return { text: 'Unread', tone: 'neutral' };
    case 'read':
      return { text: 'Read', tone: 'subdued' };
    default:
      return { text: status, tone: 'neutral' };
  }
}

type StatusTone = 'neutral' | 'subdued' | 'accent' | 'active';

export function ArticleDetail({
  payload,
  onOpen,
}: {
  payload: ArticlePayload;
  onOpen?: (url: string) => void;
}) {
  const { article, highlights, highlight_count } = payload;
  const hero = buildHeroSrc(article.image);
  const accent = article.image?.accent_color ?? 'var(--color-accent, #4c6ef5)';
  const dominant =
    article.image?.dominant_color ?? 'var(--color-surface, #2a2a2a)';

  const instapaperUrl =
    article.instapaper_app_url ?? article.instapaper_url ?? null;

  const meta = [
    article.estimated_read_min
      ? `${article.estimated_read_min} min read`
      : null,
    article.word_count ? `${article.word_count.toLocaleString()} words` : null,
    `saved ${timeAgo(article.saved_at)}`,
  ].filter(Boolean) as string[];

  const status = statusLabel(article.status);
  const showProgress =
    article.progress > 0 &&
    article.progress < 1 &&
    article.status === 'reading';
  const visibleHighlights = highlights.slice(0, 3);
  const remainingHighlights = highlight_count - visibleHighlights.length;

  return (
    <article style={cardStyle}>
      <Hero
        hero={hero}
        accent={accent}
        dominant={dominant}
        title={article.title}
      />

      <div style={bodyStyle}>
        <h1 style={titleStyle}>{article.title}</h1>
        <Byline author={article.author} domain={article.domain} />

        <div style={metaRowStyle}>
          {meta.map((m, i) => (
            <span key={i} style={metaItemStyle}>
              {m}
            </span>
          ))}
          <StatusPill text={status.text} tone={status.tone} />
        </div>

        {showProgress && (
          <ProgressBar progress={article.progress} accent={accent} />
        )}

        {article.description && (
          <p style={descriptionStyle}>{article.description}</p>
        )}

        {visibleHighlights.length > 0 && (
          <HighlightsPanel
            highlights={visibleHighlights}
            remaining={remainingHighlights}
          />
        )}

        {instapaperUrl && (
          <Footer
            url={instapaperUrl}
            sourceUrl={article.url}
            onOpen={onOpen}
            accent={accent}
          />
        )}
      </div>
    </article>
  );
}

function Hero({
  hero,
  accent,
  dominant,
  title,
}: {
  hero: { src: string; placeholder: string | null } | null;
  accent: string;
  dominant: string;
  title: string;
}) {
  const [loaded, setLoaded] = useState(false);

  if (!hero) {
    return (
      <div
        style={{
          ...heroBaseStyle,
          background: `linear-gradient(135deg, ${dominant} 0%, ${accent} 100%)`,
          display: 'flex',
          alignItems: 'flex-end',
          padding: 24,
        }}
        aria-hidden
      >
        <span style={heroFallbackTextStyle}>{title.slice(0, 1)}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        ...heroBaseStyle,
        background: dominant,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {hero.placeholder && (
        <img
          src={hero.placeholder}
          alt=""
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'blur(16px)',
            transform: 'scale(1.05)',
            opacity: loaded ? 0 : 1,
            transition: 'opacity 200ms ease',
          }}
        />
      )}
      <img
        src={hero.src}
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
          transition: 'opacity 240ms ease',
        }}
      />
    </div>
  );
}

function Byline({
  author,
  domain,
}: {
  author: string | null;
  domain: string | null;
}) {
  if (!author && !domain) return null;
  const parts: string[] = [];
  if (author) parts.push(`by ${author}`);
  if (domain) parts.push(domain);
  return <div style={bylineStyle}>{parts.join(' · ')}</div>;
}

function StatusPill({ text, tone }: { text: string; tone: StatusTone }) {
  const styles: Record<StatusTone, CSSProperties> = {
    neutral: {
      background: 'rgba(127,127,127,0.15)',
      color: 'var(--color-text-primary, inherit)',
    },
    subdued: {
      background: 'rgba(127,127,127,0.08)',
      color: 'var(--color-text-secondary, inherit)',
      fontStyle: 'italic',
    },
    accent: {
      background: 'rgba(250, 200, 50, 0.18)',
      color: '#b58a00',
    },
    active: {
      background: 'rgba(76, 110, 245, 0.15)',
      color: 'var(--color-accent, #4c6ef5)',
    },
  };
  return (
    <span
      style={{
        ...statusPillBaseStyle,
        ...styles[tone],
      }}
    >
      {text}
    </span>
  );
}

function ProgressBar({
  progress,
  accent,
}: {
  progress: number;
  accent: string;
}) {
  const pct = Math.round(progress * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${pct}% read`}
      style={progressTrackStyle}
    >
      <div
        style={{
          ...progressFillStyle,
          width: `${pct}%`,
          background: accent,
        }}
      />
    </div>
  );
}

function HighlightsPanel({
  highlights,
  remaining,
}: {
  highlights: Highlight[];
  remaining: number;
}) {
  return (
    <section style={highlightsSectionStyle}>
      <h2 style={highlightsHeadingStyle}>
        Your highlights
        <span style={highlightsCountStyle}>
          {highlights.length + Math.max(0, remaining)}
        </span>
      </h2>
      <div style={highlightsListStyle}>
        {highlights.map((h) => (
          <div key={h.id} style={highlightRowStyle}>
            <div style={highlightTextStyle}>{h.text}</div>
            {h.note && <div style={highlightNoteStyle}>{h.note}</div>}
          </div>
        ))}
      </div>
      {remaining > 0 && (
        <div style={highlightsMoreStyle}>
          + {remaining} more highlight{remaining === 1 ? '' : 's'}
        </div>
      )}
    </section>
  );
}

function Footer({
  url,
  sourceUrl,
  onOpen,
  accent,
}: {
  url: string;
  sourceUrl: string | null;
  onOpen?: (u: string) => void;
  accent: string;
}) {
  return (
    <div style={footerStyle}>
      <button
        type="button"
        onClick={() => onOpen?.(url)}
        style={{
          ...footerPrimaryStyle,
          color: accent,
          borderColor: accent,
        }}
      >
        Open in Instapaper →
      </button>
      {sourceUrl && (
        <button
          type="button"
          onClick={() => onOpen?.(sourceUrl)}
          style={footerSecondaryStyle}
        >
          Read on source
        </button>
      )}
    </div>
  );
}

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 720,
  margin: '0 auto',
  borderRadius: 12,
  overflow: 'hidden',
  border: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  background: 'var(--color-background-primary, transparent)',
};

const heroBaseStyle: CSSProperties = {
  width: '100%',
  aspectRatio: '16 / 9',
  flexShrink: 0,
};

const heroFallbackTextStyle: CSSProperties = {
  fontSize: 64,
  fontWeight: 700,
  color: 'rgba(255,255,255,0.85)',
  textShadow: '0 2px 8px rgba(0,0,0,0.25)',
  letterSpacing: -2,
};

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  padding: '20px 22px 22px',
};

const titleStyle: CSSProperties = {
  fontSize: 22,
  lineHeight: 1.25,
  fontWeight: 700,
  margin: 0,
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: 'var(--color-text-primary, inherit)',
};

const bylineStyle: CSSProperties = {
  fontSize: 14,
  opacity: 0.7,
  color: 'var(--color-text-secondary, inherit)',
};

const metaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 10,
  fontSize: 13,
  opacity: 0.75,
  color: 'var(--color-text-secondary, inherit)',
};

const metaItemStyle: CSSProperties = {
  whiteSpace: 'nowrap',
};

const statusPillBaseStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.3,
  padding: '3px 9px',
  borderRadius: 999,
  textTransform: 'uppercase',
};

const progressTrackStyle: CSSProperties = {
  height: 3,
  background: 'rgba(127,127,127,0.18)',
  borderRadius: 2,
  overflow: 'hidden',
};

const progressFillStyle: CSSProperties = {
  height: '100%',
  borderRadius: 2,
  transition: 'width 240ms ease',
};

const descriptionStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.5,
  margin: '4px 0 0',
  opacity: 0.85,
  color: 'var(--color-text-primary, inherit)',
  display: '-webkit-box',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 3,
  overflow: 'hidden',
};

const highlightsSectionStyle: CSSProperties = {
  marginTop: 4,
  paddingTop: 14,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const highlightsHeadingStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: 'uppercase',
  margin: 0,
  opacity: 0.65,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const highlightsCountStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  background: 'rgba(127,127,127,0.15)',
  color: 'inherit',
  padding: '2px 7px',
  borderRadius: 999,
  letterSpacing: 0,
};

const highlightsListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const highlightRowStyle: CSSProperties = {
  borderLeft: '3px solid var(--color-accent, #4c6ef5)',
  paddingLeft: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const highlightTextStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.45,
  fontStyle: 'italic',
  color: 'var(--color-text-primary, inherit)',
};

const highlightNoteStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.4,
  opacity: 0.7,
  color: 'var(--color-text-secondary, inherit)',
};

const highlightsMoreStyle: CSSProperties = {
  fontSize: 12,
  opacity: 0.55,
  fontStyle: 'italic',
};

const footerStyle: CSSProperties = {
  marginTop: 8,
  paddingTop: 14,
  borderTop: '1px solid var(--color-border-tertiary, rgba(127,127,127,0.12))',
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
};

const footerPrimaryStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
};

const footerSecondaryStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  padding: '8px 14px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: 'inherit',
  opacity: 0.7,
  color: 'var(--color-text-secondary, inherit)',
};
