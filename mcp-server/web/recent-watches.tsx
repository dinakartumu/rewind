import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { PosterGrid } from './components/PosterGrid.js';
import type { Watch } from './components/PosterCard.js';

type RecentWatchesPayload = {
  items: Watch[];
};

function RecentWatchesApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-recent-watches', version: '0.1.0' },
    capabilities: {},
  });

  // Apply host-provided CSS variables, fonts, and theme (light/dark).
  // The iframe inherits Claude Desktop / web's typography and color scheme.
  useHostStyles(app);

  const [items, setItems] = useState<Watch[] | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | RecentWatchesPayload
        | undefined;
      if (structured?.items) setItems(structured.items);
    };
  }, [app]);

  if (error) {
    return <div style={stateStyle}>Error: {error.message}</div>;
  }
  if (!isConnected) {
    return <div style={stateStyle}>Connecting…</div>;
  }
  if (items === null) {
    return <div style={stateStyle}>Waiting for watches…</div>;
  }

  return (
    <div style={rootStyle}>
      <PosterGrid
        items={items}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

const rootStyle: React.CSSProperties = {
  // Use the host-provided font stack when available, fall back to system UI.
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  color: 'var(--color-text-primary, inherit)',
};

const stateStyle: React.CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RecentWatchesApp />
  </StrictMode>
);
