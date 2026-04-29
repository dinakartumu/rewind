import { type CSSProperties } from 'react';

// Shared style for the brief loading / error / waiting states each
// MCP UI entry file renders before its tool result lands:
//
//   if (error) return <div style={stateStyle}>Error: …</div>;
//   if (!isConnected) return <div style={stateStyle}>Connecting…</div>;
//   if (payload === null) return <div style={stateStyle}>Waiting for …</div>;
//
// Centralized here so animation, padding, type scale, etc. live in
// one place across all 10 entries (article, artist, attended-event,
// attended-player, attended-season, recent-reads, recent-watches,
// top-albums, top-artists, top-tracks). The body bg is transparent
// in `card-tokens.ts` so this state sits on the host's container
// bg, not browser-default white.
export const stateStyle: CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};
