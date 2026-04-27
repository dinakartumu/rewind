import { StrictMode, useEffect, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { useApp, useHostStyles } from '@modelcontextprotocol/ext-apps/react';
import { GameCard, type EventDetail } from './components/GameCard.js';

function AttendedEventApp() {
  const { app, isConnected, error } = useApp({
    appInfo: { name: 'rewind-attended-event', version: '0.1.0' },
    capabilities: {},
  });

  useHostStyles(app);

  const [event, setEvent] = useState<EventDetail | null>(null);

  useEffect(() => {
    if (!app) return;
    app.ontoolresult = (result) => {
      const structured = result?.structuredContent as EventDetail | undefined;
      // get_attended_event returns the event object directly as
      // structuredContent (no wrapping `data` field).
      if (structured?.id) setEvent(structured);
    };
  }, [app]);

  if (error) return <div style={stateStyle}>Error: {error.message}</div>;
  if (!isConnected) return <div style={stateStyle}>Connecting…</div>;
  if (event === null) return <div style={stateStyle}>Waiting for event…</div>;

  return (
    <div style={rootStyle}>
      <GameCard event={event} />
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
    <AttendedEventApp />
  </StrictMode>
);
