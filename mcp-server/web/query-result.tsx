import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { QueryResult } from './components/QueryResult.js';
import type { QueryResultShape } from './lib/query-view.js';
import { rootStyle } from './lib/root-style.js';
import { stateStyle } from './lib/state-style.js';

function QueryResultApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-query-result', version: '0.1.0' },
    capabilities: {},
  });

  // Apply host-provided CSS variables, fonts, and theme (light/dark).
  useHostStyles(app);

  const [payload, setPayload] = useState<QueryResultShape | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | QueryResultShape
        | undefined;
      // Accept any result with a columns/rows shape — the component
      // auto-detects the view and never crashes on odd data.
      if (structured && Array.isArray(structured.columns)) {
        setPayload(structured);
      }
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return null;
  if (payload === null) return null;

  return (
    <div style={rootStyle}>
      <QueryResult
        payload={payload}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryResultApp />
  </StrictMode>
);
