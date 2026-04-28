import { type CSSProperties } from 'react';

// Shared root-style for every MCP UI entry point (article.tsx,
// artist.tsx, attended-player.tsx, etc.). Each entry mounts its
// component inside a single `<div style={rootStyle}>` whose only job is
// to pull in the host-provided font stack + text color so children
// inherit them.
//
// **Do not add padding here.** The MCP host (Claude Desktop / iOS)
// supplies its own outer container; any padding on this div lives
// between the iframe edge and our top-level card and shows up as a
// visible gap on iOS (Desktop's host has no outer container, so the
// gap was invisible there). Body margin is reset alongside this in
// `card-tokens.ts`'s auto-injected CSS.
export const rootStyle: CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  color: 'var(--color-text-primary, inherit)',
};
