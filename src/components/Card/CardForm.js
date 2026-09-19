import React, { useEffect, useMemo, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { guessFields, stripHtmlForPreview } from '../../utils/ankiFields';
import LANGUAGES from '../../constants/languages';
import { ANKI_READY_MODES } from '../../utils/ankiModeText';
import BulkAddForm from './BulkAddForm';
import './CardForm.css';

/**
 * Add a note to an Anki deck, with generated audio for one of its fields.
 *
 * The field mapping (which field is read aloud, which field receives the
 * clip) is guessed per note type (see ankiFields.js) but always shown and
 * changeable - a note type is the user's own, not ours, the same principle
 * anki/addon/amgi_bridge's own fill-audio dialog is built on.
 */
const CardForm = ({ deckId }) => {
  const { ankiNotetypes, ensureAnkiNotetypes, addAnkiNote, ankiStatus } = useDecks();
  const [notetypeId, setNotetypeId] = useState(null);
  const [fields, setFields] = useState([]);
  const [textFieldIndex, setTextFieldIndex] = useState(null);
  const [audioFieldIndex, setAudioFieldIndex] = useState(null);
  const [language, setLanguage] = useState('ko');
  const [generating, setGenerating] = useState(false);
  const [audioResult, setAudioResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveWarning, setSaveWarning] = useState('');
  // 'single' is today's one-field-at-a-time form; 'bulk' is the
  // paste-lyrics-get-many-cards screen (BulkAddForm.js). Both share the
  // note type / field-mapping / language controls above, on purpose - see
  // BulkAddForm.js's own module comment for why it takes those as props
  // rather than asking again.
  const [mode, setMode] = useState('single');
  // Which note type the form (fields, guess) was last reset for - compared
  // during render, not in an effect, so picking a note type resets the form
  // in the same commit rather than flashing the old fields for a frame.
  const [resetForNotetypeId, setResetForNotetypeId] = useState(null);

  useEffect(() => {
    ensureAnkiNotetypes();
  }, [ensureAnkiNotetypes]);

  // Defaults to the first note type once the list arrives; derived directly
  // from render inputs rather than mirrored into its own state, so there is
  // nothing to keep in sync via an effect.
  const effectiveNotetypeId = notetypeId ?? ankiNotetypes[0]?.id ?? null;
  const notetype = useMemo(
    () => ankiNotetypes.find((nt) => nt.id === effectiveNotetypeId) || null,
    [ankiNotetypes, effectiveNotetypeId],
  );

  // Resetting fields and the field-mapping guess when the note type changes
  // (see React's own guidance on adjusting state during rendering, rather
  // than in an effect, for exactly this "derived state after a prop/selection
  // change" case).
  if (notetype && notetype.id !== resetForNotetypeId) {
    setResetForNotetypeId(notetype.id);
    setFields(notetype.fieldNames.map(() => ''));
    const guess = guessFields(notetype);
    setTextFieldIndex(guess.textIndex);
    setAudioFieldIndex(guess.audioIndex);
    setAudioResult(null);
    setError('');
    setSaveWarning('');
  }

  const ready = ANKI_READY_MODES.has(ankiStatus?.mode);

  const handleFieldChange = (index, value) => {
    setFields((prev) => prev.map((f, i) => (i === index ? value : f)));
    setAudioResult(null);
    setSaveWarning('');
  };

  const handleGenerate = async () => {
    if (textFieldIndex === null || audioFieldIndex === null) {
      setError('Pick both a "read aloud" and a "write audio into" field first.');
      return;
    }
    const text = stripHtmlForPreview(fields[textFieldIndex]);
    if (!text) {
      setError('The field to read aloud is empty.');
      return;
    }
    setError('');
    setGenerating(true);
    setAudioResult(null);
    try {
      const result = await ankiApi.generateAudio(text, language);
      setAudioResult(result);
      setFields((prev) => prev.map((f, i) => (i === audioFieldIndex ? `${f}[sound:${result.filename}]` : f)));
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!notetype) return;
    setError('');
    setSaveWarning('');
    setSaving(true);
    try {
      // language/textFieldIndex are the same picks the "Generate Audio"
      // button already uses - passing them along too lets the server flag a
      // learning-language field that looks entirely romanised (see
      // DeckContext.addAnkiNote and cardText.ts's looksRomanized). Omitted
      // when no "read aloud" field is chosen, so nothing is checked then.
      const result = await addAnkiNote(deckId, {
        notetypeId: notetype.id,
        fields,
        tags: [],
        language,
        learningFieldIndex: textFieldIndex === null ? undefined : textFieldIndex,
      });
      // A romanisation warning is not an error: the note was added, this is
      // only worth a glance (see cardText.ts's looksRomanized docstring for
      // why it never blocks the save).
      if (result?.warning) setSaveWarning(result.warning);
      setFields(notetype.fieldNames.map(() => ''));
      setAudioResult(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (ankiNotetypes.length === 0) {
    return (
      <div className="card-form-container">
        <p>Loading note types…</p>
      </div>
    );
  }

  return (
    <div className="card-form-container">
      <form onSubmit={handleSave} className="card-form">
        <div className="form-group">
          <label htmlFor="ankiNotetype">Note type</label>
          <select
            id="ankiNotetype"
            value={notetypeId ?? ''}
            onChange={(e) => setNotetypeId(Number(e.target.value))}
          >
            {ankiNotetypes.map((nt) => (
              <option key={nt.id} value={nt.id}>{nt.name}</option>
            ))}
          </select>
        </div>

        {notetype && (
          <div className="form-group card-form-mode-toggle" role="group" aria-label="Add one note or paste many lines">
            <button
              type="button"
              className={mode === 'single' ? 'card-form-mode-active' : ''}
              onClick={() => setMode('single')}
            >
              One note
            </button>
            <button
              type="button"
              className={mode === 'bulk' ? 'card-form-mode-active' : ''}
              onClick={() => setMode('bulk')}
            >
              Paste multiple lines
            </button>
          </div>
        )}

        {mode === 'single' && notetype?.fieldNames.map((name, index) => (
          <div className="form-group" key={name}>
            <label htmlFor={`ankiField-${index}`}>{name}</label>
            <textarea
              id={`ankiField-${index}`}
              value={fields[index] || ''}
              onChange={(e) => handleFieldChange(index, e.target.value)}
              rows={2}
            />
          </div>
        ))}

        {notetype && (
          <div className="form-group" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 auto' }}>
              Read aloud
              <select
                value={textFieldIndex ?? ''}
                onChange={(e) => setTextFieldIndex(Number(e.target.value))}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              >
                {notetype.fieldNames.map((name, index) => (
                  <option key={name} value={index}>{name}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: '1 1 auto' }}>
              Write audio into
              <select
                value={audioFieldIndex ?? ''}
                onChange={(e) => setAudioFieldIndex(Number(e.target.value))}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              >
                {notetype.fieldNames.map((name, index) => (
                  <option key={name} value={index}>{name}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: '1 1 auto' }}>
              Language
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              >
                {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
                  <option key={code} value={code}>{flag} {name}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {mode === 'single' && error && <div className="error-message">{error}</div>}

        {mode === 'single' && saveWarning && (
          <div className="error-message" style={{ background: 'none', color: '#d0a030', border: '1px solid #d0a030' }}>
            {saveWarning}
          </div>
        )}

        {mode === 'single' && audioResult && (
          <div className="error-message" style={{ background: 'none', color: audioResult.mocked ? '#d0a030' : '#4caf50', border: `1px solid ${audioResult.mocked ? '#d0a030' : '#4caf50'}` }}>
            {audioResult.mocked
              ? `Audio generated (mocked - ${audioResult.reason})`
              : audioResult.reused
                ? `Audio reused (already generated): ${audioResult.filename}`
                : `Audio generated: ${audioResult.filename}`}
          </div>
        )}

        {mode === 'single' && (
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="generate-button"
              onClick={handleGenerate}
              disabled={!ready || generating || saving}
            >
              {generating ? 'Generating…' : 'Generate Audio'}
            </button>
            <button type="submit" className="generate-button" disabled={!ready || saving || generating}>
              {saving ? 'Adding…' : 'Add Note'}
            </button>
          </div>
        )}
        {!ready && (
          <small style={{ display: 'block', marginTop: '0.5rem', opacity: 0.75 }}>
            Anki is not reachable right now - see the status banner above.
          </small>
        )}

        {mode === 'bulk' && notetype && (
          <BulkAddForm
            deckId={deckId}
            notetype={notetype}
            textFieldIndex={textFieldIndex}
            audioFieldIndex={audioFieldIndex}
            language={language}
            ready={ready}
          />
        )}
      </form>
    </div>
  );
};

export default CardForm;
