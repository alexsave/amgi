import React, { useEffect, useMemo, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { ANKI_READY_MODES } from '../../utils/ankiModeText';
import { LANGUAGES } from '../../constants/languages';
import CardPanel from './CardPanel';
import BulkAddForm from './BulkAddForm';
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
  const { ankiNotetypes, ensureAnkiNotetypes, addAnkiNote, ankiStatus, refreshAnkiDecks } = useDecks();
  const [mode, setMode] = useState('single');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(null);

  const ready = ANKI_READY_MODES.has(ankiStatus?.mode);

  useEffect(() => { ensureAnkiNotetypes(); }, [ensureAnkiNotetypes]);

  const notetype = useMemo(
    () => ankiNotetypes.find((nt) => nt.name === AMGI_NOTETYPE_NAME) || null,
    [ankiNotetypes],
  );

  const makeCard = async () => {
    const phrase = input.trim();
    if (!phrase || !notetype) return;
    setError('');
    setBusy(true);
    setAdded(null);
    try {
      // One request writes both sides and records both clips, in that order,
      // so the reading the text call produced is still in hand when the audio
      // is made (see src/server/anki/cardText.js for why that cannot be two
      // round trips).
      const card = await ankiApi.generateCardText(phrase, languages.known, languages.learning, {
        includeCueAudio: true,
      });

      const idx = fieldIndexes(notetype);
      const values = notetype.fieldNames.map(() => '');
      if (idx.cue >= 0) values[idx.cue] = card.front_text;
      if (idx.target >= 0) values[idx.target] = card.back_text;
      if (idx.targetAudio >= 0) values[idx.targetAudio] = card.audio?.reference || '';
      if (idx.cueAudio >= 0) values[idx.cueAudio] = card.cueAudio?.reference || '';
      // The Language field was editable and permanently empty, because
      // nothing ever wrote it. Generation knows the answer, so it writes it.
      if (idx.language >= 0) values[idx.language] = languages.learning;

      const result = await addAnkiNote(deckId, {
        notetypeId: notetype.id,
        fields: values,
        tags: [],
        language: languages.learning,
        learningFieldIndex: idx.target >= 0 ? idx.target : undefined,
      });

      setAdded({
        noteId: result?.noteId ?? result?.id ?? null,
        fields: values,
        target: card.back_text,
        cue: card.front_text,
        targetAudio: card.audio?.filename || '',
        cueAudio: card.cueAudio?.filename || '',
        warning: result?.warning || '',
        mocked: Boolean(card.audio?.mocked),
      });
      setInput('');
      refreshAnkiDecks();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (ankiNotetypes.length === 0) {
    return <div className="card-form-container"><p className="card-form-hint">Loading…</p></div>;
  }

  // The note type is created by the add-on when Anki starts, so its absence
  // has exactly one cause and exactly one fix.
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
      <div className="card-form-modes" role="group" aria-label="Add one card or paste a list">
        <button type="button" className={mode === 'single' ? 'on' : ''} onClick={() => setMode('single')}>
          One card
        </button>
        <button type="button" className={mode === 'bulk' ? 'on' : ''} onClick={() => setMode('bulk')}>
          Paste a list
        </button>
      </div>

      {mode === 'single' ? (
        <>
          <div className="card-form-lead">
            <input
              id="amgiCardInput"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') makeCard(); }}
              placeholder={`Type a phrase in ${languageLabel(languages.known)} or ${languageLabel(languages.learning)}`}
              disabled={!ready || busy}
            />
            <button type="button" className="card-form-go" onClick={makeCard} disabled={!ready || busy || !input.trim()}>
              {busy ? 'Making…' : 'Make the card'}
            </button>
          </div>
          {error && <p className="card-form-error">{error}</p>}

          {added && (
            <CardPanel
              key={added.noteId}
              noteId={added.noteId}
              notetype={notetype}
              idx={fieldIndexes(notetype)}
              initialFields={added.fields}
              languages={{
                ...languages,
                knownName: languageLabel(languages.known),
                learningName: languageLabel(languages.learning),
              }}
              onDeleted={() => { setAdded(null); refreshAnkiDecks(); }}
              footer={
                <>
                  <span className="card-panel-ok">Added to the deck.</span> It is in Anki already; changes here save as you make them.
                  {added.mocked ? ' Audio is a placeholder - no OpenAI key is set.' : ''}
                </>
              }
            />
          )}
          {added?.warning && <p className="card-form-warning">{added.warning}</p>}

        </>
      ) : (
        <BulkAddForm
          deckId={deckId}
          notetype={notetype}
          textFieldIndex={fieldIndexes(notetype).target}
          audioFieldIndex={fieldIndexes(notetype).targetAudio}
          cueAudioFieldIndex={fieldIndexes(notetype).cueAudio}
          knownFieldIndex={fieldIndexes(notetype).cue}
          knownLanguage={languages.known}
          learningLanguage={languages.learning}
          ready={ready}
        />
      )}

    </div>
  );
};

export default CardForm;
