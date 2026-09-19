import React from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiModePresentation } from '../../utils/ankiModeText';

// The single most important piece of state this surface has: which Anki
// transport is live right now, or why neither is. Shown everywhere (the
// navbar, not just the decks screen) because it changes the meaning of
// every Anki-sourced deck on screen, and it changes without any action of
// the user's own - closing Anki, or the bridge going up or down - so it has
// to be something a person glances at, not something they have to ask for.
export default function AnkiModeBadge() {
  const { ankiStatus } = useDecks();
  const presentation = ankiModePresentation(ankiStatus?.mode);

  return (
    <span
      title={presentation.title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
        fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.02em',
        border: '1px solid var(--border-color)', borderRadius: '999px',
        padding: '0.2rem 0.6rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: presentation.color, flexShrink: 0 }} />
      {presentation.label}
    </span>
  );
}
