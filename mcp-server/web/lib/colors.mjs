// Single source of truth for the card surface + border colors used
// across the MCP UI bundles. Values must stay in lockstep across:
//
//   - web/lib/card-tokens.ts: declares `--card-bg` / `--card-border`
//     at :root + the body-bg fallback inside CARD_TOKENS_CSS.
//   - web-workbench/src/themes/host-styles.ts: the workbench's
//     manual Light/Dark toggle (mocks what the host injects in
//     production).
//   - scripts/inline-bundles.mjs: the build-time HTML head <style>
//     and the inline <html style> attribute — both referenced
//     before any CSS variables are resolvable, so they hardcode
//     these literal hex values.
//
// Plain ESM (.mjs) so the Node-side build script and the
// TypeScript modules can import the same file. Imported as
// `./colors.mjs` from TS and as `../web/lib/colors.mjs` from
// inline-bundles.mjs. NodeNext module resolution lets TS pull
// types via inference on the literal exports.

export const CARD_BG_LIGHT = '#fcfcfa';
export const CARD_BG_DARK = '#272726';
export const CARD_BORDER_LIGHT = '#d9d9d9';
export const CARD_BORDER_DARK = '#383836';
