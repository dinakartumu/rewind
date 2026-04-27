/**
 * Approximations of the CSS variables Claude Desktop / iOS injects into
 * MCP UI iframes via `useHostStyles(app)`. Anthropic doesn't publish exact
 * values, so these are eyeballed from observed renders and refined as we
 * iterate. The host can change these any time — treat as best-effort.
 */
export type Theme = 'light' | 'dark';

const lightVars: Record<string, string> = {
  '--font-sans':
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", system-ui, sans-serif',
  '--color-text-primary': '#1a1a1a',
  '--color-text-secondary': 'rgba(0,0,0,0.62)',
  '--color-background-secondary': 'rgba(0,0,0,0.04)',
  '--color-border-tertiary': 'rgba(0,0,0,0.10)',
  // Bug-bait: GameCard.tsx references --color-bg-secondary instead of
  // --color-background-secondary. We deliberately don't define the typo'd
  // name so the workbench surfaces the inconsistency.
};

const darkVars: Record<string, string> = {
  '--font-sans':
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", system-ui, sans-serif',
  '--color-text-primary': '#f5f5f7',
  '--color-text-secondary': 'rgba(255,255,255,0.65)',
  '--color-background-secondary': 'rgba(255,255,255,0.06)',
  '--color-border-tertiary': 'rgba(255,255,255,0.12)',
};

// Claude's signature warm cream + dark surface. The component renders directly
// onto these — no white card, no shadow — to match what Claude Desktop shows.
const lightPage = {
  background: '#faf9f5',
  color: '#1a1a1a',
};

const darkPage = {
  background: '#262624',
  color: '#f5f5f7',
};

export function themeStyleSheet(theme: Theme): string {
  const vars = theme === 'dark' ? darkVars : lightVars;
  const page = theme === 'dark' ? darkPage : lightPage;
  const decls = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return `
:root {
  color-scheme: ${theme};
${decls}
}
html, body {
  margin: 0;
  background: ${page.background};
  color: ${page.color};
  font-family: var(--font-sans);
  -webkit-font-smoothing: antialiased;
  /* Hide scrollbars in the workbench iframe — the rest of the conversation
     scrolls in real Claude, so the embedded component never shows its own.   */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
html::-webkit-scrollbar,
body::-webkit-scrollbar {
  display: none;
  width: 0;
  height: 0;
}
`;
}
