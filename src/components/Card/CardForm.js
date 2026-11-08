import React, { useEffect, useMemo, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ANKI_READY_MODES } from '../../utils/ankiModeText';
import { LANGUAGES } from '../../constants/languages';
import { parseLyricsPaste } from '../../utils/lyricsParse';
import BulkRun from './BulkRun';
import { AMGI_NOTETYPE_NAME, fieldIndexes } from '../../utils/amgiNotetype';
import './CardForm.css';

// Adding a card, once amgi stopped pretending to be a general Anki editor.
//
// This file used to be 478 lines and it asked nine questions before you could
// type anything: which note type (defaulting to Basic), which field holds the
// known language, which field to read aloud, which field to write each of two
// clips into, which two languages, and then offered both "Generate text +
// audio" and a second "Generate Audio" button plus "Add Note". Every one of
// those existed because the app could not assume anything about the
// collection it was pointed at.
//
// It can now. amgi installs its own note type, so the field names are fixed,
// which side is which language is fixed, and where each clip belongs is
// fixed. What is left is one text box and one button, and the card goes
// straight into the deck: a card you have already paid to generate is not
// something to then confirm.
//
// The two languages did not vanish, they moved. They are a property of the
// deck, not of each card you add to it, so they are shown and changed on the
// deck header (see DeckHeaderLanguages) and remembered per deck.

// LANGUAGES is keyed by code, not a list.
const languageLabel = (code) => LANGUAGES[code]?.name || code;
const languageCodes = Object.keys(LANGUAGES);

const CardForm = ({ deckId, languages, onLanguagesChange }) => {
  const { ankiNotetypes, ensureAnkiNotetypes, ankiStatus } = useDecks();
  const [input, setInput] = useState('');
  // Set on submit: the lines being made, which BulkRun shows one row each.
  const [bulkLines, setBulkLines] = useState(null);

  const ready = ANKI_READY_MODES.has(ankiStatus?.mode);

  useEffect(() => { ensureAnkiNotetypes(); }, [ensureAnkiNotetypes]);

  const notetype = useMemo(
    () => ankiNotetypes.find((nt) => nt.name === AMGI_NOTETYPE_NAME) || null,
    [ankiNotetypes],
  );

  // One box, and the line count decides what happens - not a pair of tabs
  // asking the person to classify their own paste first. Pasting ten lines
  // and typing one are the same act.
  const parsed = () => parseLyricsPaste(input, { skipSectionMarkers: true });
  const lineCount = input.trim() ? parsed().lines.length : 0;

  const submit = () => {
    if (!input.trim() || !notetype) return;
    // One press does the whole thing, for one line or fifty: the same queue,
    // the same status row per line, no preview to confirm, no separate "add",
    // no separate "generate audio".
    setBulkLines(parsed().lines.map((line) => line.text));
  };

  if (ankiNotetypes.length === 0) {
    return <div className="card-form-container"><p className="card-form-hint">Loading…</p></div>;
  }

  // With Anki closed the installer creates the note type itself, so it is only
  // missing when Anki was open during the install (the add-on makes it at the
  // next start) or the note type was deleted: one fix either way.
  if (!notetype) {
    return (
      <div className="card-form-container">
        <p className="card-form-hint">
          Restart Anki once and it will add the &ldquo;{AMGI_NOTETYPE_NAME}&rdquo; card type to your
          collection. amgi builds every card on that type.
        </p>
      </div>
    );
  }

  return (
    <div className="card-form-container">
      <div className="card-form-lead">
        <textarea
          id="amgiCardInput"
          className="card-form-input"
          value={input}
          onChange={(e) => { setInput(e.target.value); setBulkLines(null); }}
          onKeyDown={(e) => {
            // Enter submits a single line; Shift+Enter makes a second line,
            // which is how you get to the many-cards case by typing rather
            // than only by pasting.
            if (e.key === 'Enter' && !e.shiftKey && !input.includes('\n')) {
              e.preventDefault();
              submit();
            }
          }}
          rows={input.includes('\n') ? Math.min(10, input.split('\n').length + 1) : 1}
          placeholder={`Type or paste in ${languageLabel(languages.known)} or ${languageLabel(languages.learning)}. One line per card.`}
          disabled={!ready}
        />
        <button type="button" className="card-form-go" onClick={submit} disabled={!ready || !input.trim()}>
          {lineCount > 1 ? `Make ${lineCount} cards` : 'Make the card'}
        </button>
      </div>

      {bulkLines && (
        <BulkRun
          deckId={deckId}
          notetype={notetype}
          idx={fieldIndexes(notetype)}
          lines={bulkLines}
          languages={{
            ...languages,
            knownName: languageLabel(languages.known),
            learningName: languageLabel(languages.learning),
          }}
          onFinished={() => setInput('')}
        />
      )}
    </div>
  );
};

export default CardForm;
