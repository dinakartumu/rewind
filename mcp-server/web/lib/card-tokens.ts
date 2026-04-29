// Centralized outer-card chrome — bg + border + radius + overflow — so
// every top-level MCP UI surface (AlbumGrid, PosterGrid, ArticleList,
// ArticleDetail, ArtistDetail, AthleteDetail/A, GameCard, TopTracks,
// ArtistGrid) renders the same container in light + dark mode and
// across hosts.
//
// Theme switching is driven by `prefers-color-scheme: dark`, which
// matches both macOS system theme and the `color-scheme` declaration
// the workbench (and Claude) sets on `:root`.
//
// Two injection paths share this CSS string:
//   1. Module-level side effect below — covers production, where
//      components mount inside their own iframe and `document` is
//      already the iframe's document.
//   2. `web-workbench/src/IframeShell.tsx` imports `CARD_TOKENS_CSS`
//      and injects it into the workbench iframe's document, because
//      the workbench portals React children into an iframe and the
//      module's parent-side side effect would target the wrong doc.
//
// Card-radius single point of control:
//   - The `.rewind-card-outer` class binds `border-radius` to
//     `var(--rewind-card-radius)`, default 12px.
//   - The iOS-only override below detects `/iPad|iPhone|iPod/` in the
//     userAgent and rewrites the var to 0. Claude iOS wraps the
//     iframe in its own rounded container; if we ALSO round the
//     content the two masks fight at the corner and our 1px border
//     gets washed out. Setting our radius to 0 lets Claude's outer
//     mask be the only thing rounding the visible card.
//   - Workbench and Claude Desktop never match the iOS UA, so they
//     keep the 12px default — which is correct since neither has an
//     outer rounded host wrapper to defer to.
//
// Future card-shape tweaks (radius, overflow, future host overrides)
// live in this file; components only carry the className.

import { type CSSProperties } from 'react';

export const CARD_TOKENS_STYLE_ID = 'rewind-card-tokens';
export const CARD_TOKENS_IOS_OVERRIDE_STYLE_ID = 'rewind-card-tokens-ios';

/** className applied to every top-level card root element. */
export const CARD_OUTER_CLASSNAME = 'rewind-card-outer';

export const CARD_TOKENS_CSS = `
html, body {
  margin: 0;
  padding: 0;
}
:root {
  --card-bg: #fcfcfa;
  --card-border: #d9d9d9;
  --rewind-card-radius: 12px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --card-bg: #272726;
    --card-border: #383836;
  }
}
.${CARD_OUTER_CLASSNAME} {
  border-radius: var(--rewind-card-radius);
  overflow: hidden;
}
/* Kill iOS WebKit's default gray rectangular tap-highlight on every
   interactive element across the iframe — it ignores border-radius
   and looks ugly on cards with rounded chrome. Replace it with a
   subtle :active background tint on real buttons / role=button
   elements so the user still gets touch feedback. Plain
   <div onClick> rows fall through this generic rule and need an
   :active style of their own. */
* {
  -webkit-tap-highlight-color: transparent;
}
button:active,
[role='button']:active,
a:active {
  background-color: rgba(127, 127, 127, 0.08);
}
`;

const IOS_RADIUS_OVERRIDE_CSS = `:root { --rewind-card-radius: 0px; }`;

if (typeof document !== 'undefined') {
  if (!document.getElementById(CARD_TOKENS_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = CARD_TOKENS_STYLE_ID;
    style.textContent = CARD_TOKENS_CSS;
    document.head.appendChild(style);
  }

  // iOS-only override: see the radius-control comment at the top of
  // the file for the rationale. UA sniffing is the simplest reliable
  // signal — Claude Desktop's Electron Chromium and the workbench's
  // host browser never match this regex.
  if (
    typeof navigator !== 'undefined' &&
    /iPad|iPhone|iPod/.test(navigator.userAgent) &&
    !document.getElementById(CARD_TOKENS_IOS_OVERRIDE_STYLE_ID)
  ) {
    const override = document.createElement('style');
    override.id = CARD_TOKENS_IOS_OVERRIDE_STYLE_ID;
    override.textContent = IOS_RADIUS_OVERRIDE_CSS;
    document.head.appendChild(override);
  }
}

// Spread into the cardStyle of any top-level container component.
// (Radius + overflow are applied via the `.rewind-card-outer`
// className — see CARD_OUTER_CLASSNAME — so they can vary per host.)
export const cardOuterChrome: CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border)',
};
