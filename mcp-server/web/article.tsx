import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import {
  ArticleDetail,
  type ArticlePayload,
} from './components/ArticleDetail.js';

function ArticleApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-article', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [payload, setPayload] = useState<ArticlePayload | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as
        | ArticlePayload
        | undefined;
      if (structured?.article?.id) setPayload(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return <div style={stateStyle}>Connecting…</div>;
  if (payload === null)
    return <div style={stateStyle}>Waiting for article…</div>;

  return (
    <div style={rootStyle}>
      <ArticleDetail
        payload={payload}
        onOpen={(url) => {
          app?.openLink({ url });
        }}
      />
    </div>
  );
}

const rootStyle: CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  color: 'var(--color-text-primary, inherit)',
  padding: 4,
};

const stateStyle: CSSProperties = {
  fontFamily: 'var(--font-sans, system-ui, -apple-system, sans-serif)',
  padding: 24,
  textAlign: 'center',
  opacity: 0.6,
  fontSize: 14,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ArticleApp />
  </StrictMode>
);
