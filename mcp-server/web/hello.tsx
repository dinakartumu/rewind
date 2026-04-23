import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp } from '@modelcontextprotocol/ext-apps/react';

function Hello() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-hello', version: '0.1.0' },
    capabilities: {},
  });

  const [toolResult, setToolResult] = useState<unknown>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => setToolResult(result);
  }, [app]);

  if (error) {
    return (
      <div style={{ ...baseStyle, color: '#b00020' }}>
        Error: {error.message}
      </div>
    );
  }
  if (!isConnected) return <div style={baseStyle}>Connecting…</div>;

  return (
    <div style={baseStyle}>
      <h1 style={{ margin: '0 0 12px', fontSize: 20 }}>
        Rewind MCP App pipeline is live.
      </h1>
      <p style={{ margin: '0 0 8px', opacity: 0.7 }}>Tool result from host:</p>
      <pre
        style={{
          background: 'rgba(0,0,0,0.05)',
          padding: 12,
          borderRadius: 8,
          overflow: 'auto',
          fontSize: 12,
          margin: 0,
        }}
      >
        {toolResult
          ? JSON.stringify(toolResult, null, 2)
          : '(waiting for tool result...)'}
      </pre>
    </div>
  );
}

const baseStyle: React.CSSProperties = {
  fontFamily: 'system-ui, -apple-system, sans-serif',
  padding: 16,
  color: 'inherit',
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Hello />
  </StrictMode>
);
