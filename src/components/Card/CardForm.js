import React, { useEffect, useMemo, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { guessFields, guessKnownFieldIndex, stripHtmlForPreview } from '../../utils/ankiFields';
import LANGUAGES from '../../constants/languages';
import { ANKI_READY_MODES } from '../../utils/ankiModeText';
import { loadDeckLanguages, saveDeckLanguages } from '../../utils/deckLanguagePrefs';
import BulkAddForm from './BulkAddForm';
import './CardForm.css';

/**
 * Add a note to an Anki deck, with generated audio for its audio field(s), or
 * generated TEXT for both sides plus that same audio in one pass (see
 * src/server/anki/cardText.js for why text and audio are never split across
 * two calls).
 *
 * The field mapping (which field holds the known-language side, which holds
 * the learning-language side that gets read aloud, which field(s) receive a
 * clip) is guessed per note type (see ankiFields.js) but always shown and
 * changeable - a note type is the user's own, not ours, the same principle
 * anki/addon/amgi_bridge's own fill-audio dialog is built on. Generation only
 * ever fills these fields' own textareas; nothing is written to Anki until
 * "Add Note" is pressed, so a generated side is exactly as editable as one
 * typed by hand.
 *
 * A note type with two audio-looking fields (the amgi Listening note type's
 * own CueAudio/TargetAudio, see anki/README.md) gets audio in both: the
 * known-language prompt clip into cueAudioFieldIndex, the learning-language
 * answer clip into audioFieldIndex. Every clip is written as an HTML
 * `<audio src="...">` reference (plusaudio/lib/deck's renderAudioReference),
 * never `[sound:...]` - Anki strips sound tags before a template's own
 * JavaScript can see them, which is exactly what the amgi Listening
 * template's loop needs to see them for.
 */
const CardForm = ({ deckId }) => {
  const { ankiNotetypes, ensureAnkiNotetypes, addAnkiNote, ankiStatus } = useDecks();
  const [notetypeId, setNotetypeId] = useState(null);
  const [fields, setFields] = useState([]);
  const [textFieldIndex, setTextFieldIndex] = useState(null);
  const [audioFieldIndex, setAudioFieldIndex] = useState(null);
  // The known-language prompt clip (CueAudio on the anki/ card template -
  // played before the mic opens). null means "this note type has no such
  // field" or "skip it" - see the "Write known-language audio into" select's
  // "(none)" option below. Unlike audioFieldIndex, a card can genuinely work
  // without this for a note type that isn't the amgi template.
  const [cueAudioFieldIndex, setCueAudioFieldIndex] = useState(null);
  const [knownFieldIndex, setKnownFieldIndex] = useState(null);
  // The language pair has nowhere else to live: Anki decks carry no language
  // metadata, so this is remembered per deck in this browser only (see
  // deckLanguagePrefs.js) and re-read whenever the deck changes.
  const [knownLanguage, setKnownLanguage] = useState('en');
  const [learningLanguage, setLearningLanguage] = useState('ko');
  const [wordInput, setWordInput] = useState('');
  const [textGenerating, setTextGenerating] = useState(false);
  const [textGenError, setTextGenError] = useState('');
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
  // Same "derived state during render" shape for the deck itself: which deck
  // the language pair above was last loaded for, so switching decks swaps in
  // that deck's remembered pair in the same commit rather than a later effect.
  const [languagesLoadedForDeckId, setLanguagesLoadedForDeckId] = useState(undefined);

  useEffect(() => {
    ensureAnkiNotetypes();
  }, [ensureAnkiNotetypes]);

  if (deckId !== languagesLoadedForDeckId) {
    setLanguagesLoadedForDeckId(deckId);
    const { known, learning } = loadDeckLanguages(deckId);
    setKnownLanguage(known);
    setLearningLanguage(learning);
  }

  const updateKnownLanguage = (value) => {
    setKnownLanguage(value);
    saveDeckLanguages(deckId, { known: value, learning: learningLanguage });
  };
  const updateLearningLanguage = (value) => {
    setLearningLanguage(value);
    saveDeckLanguages(deckId, { known: knownLanguage, learning: value });
  };

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
    setCueAudioFieldIndex(guess.cueAudioIndex);
    setKnownFieldIndex(guessKnownFieldIndex(notetype, guess.textIndex, guess.audioIndex, guess.cueAudioIndex));
    setAudioResult(null);
    setError('');
    setSaveWarning('');
    setTextGenError('');
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
    const wantsCue = cueAudioFieldIndex !== null;
    const cueText = wantsCue && knownFieldIndex !== null ? stripHtmlForPreview(fields[knownFieldIndex]) : '';
    if (wantsCue && !cueText) {
      setError('The known-language field is empty, so there is nothing to generate its cue audio from.');
      return;
    }
    setError('');
    setGenerating(true);
    setAudioResult(null);
    try {
      // Two separate clips, learning-language then known-language, never one
      // call reused for both - CueAudio and TargetAudio are different
      // languages, see this component's own module comment.
      const target = await ankiApi.generateAudio(text, learningLanguage);
      const cue = wantsCue ? await ankiApi.generateAudio(cueText, knownLanguage) : null;
      setAudioResult({ target, cue });
      setFields((prev) => prev.map((f, i) => {
        if (i === audioFieldIndex) return `${f}${target.reference}`;
        if (cue && i === cueAudioFieldIndex) return `${f}${cue.reference}`;
        return f;
      }));
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerateText = async () => {
    if (knownFieldIndex === null || textFieldIndex === null || audioFieldIndex === null) {
      setTextGenError('Pick a known-language field, a learning-language ("Read aloud") field and a "Write audio into" field first.');
      return;
    }
    const input = wordInput.trim();
    if (!input) {
      setTextGenError('Type a word or phrase to generate a card from.');
      return;
    }
    setTextGenError('');
    setError('');
    setTextGenerating(true);
    setAudioResult(null);
    try {
      // One request generates both sides AND the audio (or both audios, with
      // includeCueAudio), in that order, so the reading the text call
      // produces is still in hand when the audio call is made - see
      // src/server/anki/cardText.js for why that has to happen in one pass
      // rather than two.
      const card = await ankiApi.generateCardText(input, knownLanguage, learningLanguage, {
        includeCueAudio: cueAudioFieldIndex !== null,
      });
      setFields((prev) => prev.map((f, i) => {
        if (i === knownFieldIndex) return card.front_text;
        if (i === textFieldIndex) return card.back_text;
        if (i === audioFieldIndex) return card.audio?.reference || f;
        if (cueAudioFieldIndex !== null && i === cueAudioFieldIndex) return card.cueAudio?.reference || f;
        return f;
      }));
      if (card.audio) setAudioResult({ target: card.audio, cue: card.cueAudio || null });
    } catch (err) {
      setTextGenError(err.message);
    } finally {
      setTextGenerating(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!notetype) return;
    setError('');
    setSaveWarning('');
    setSaving(true);
    try {
      // learningLanguage/textFieldIndex are the same picks generation already
      // uses - passing them along too lets the server flag a learning-language
      // field that looks entirely romanised (see DeckContext.addAnkiNote and
      // cardText.ts's looksRomanized). Omitted when no "read aloud" field is
      // chosen, so nothing is checked then.
      const result = await addAnkiNote(deckId, {
        notetypeId: notetype.id,
        fields,
        tags: [],
        language: learningLanguage,
        learningFieldIndex: textFieldIndex === null ? undefined : textFieldIndex,
      });
      // A romanisation warning is not an error: the note was added, this is
      // only worth a glance (see cardText.ts's looksRomanized docstring for
      // why it never blocks the save).
      if (result?.warning) setSaveWarning(result.warning);
      setFields(notetype.fieldNames.map(() => ''));
      setAudioResult(null);
      setWordInput('');
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

        {mode === 'single' && notetype && (
          <div className="form-group">
            <label htmlFor="ankiWordInput">Generate a card from a word or phrase</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                id="ankiWordInput"
                type="text"
                value={wordInput}
                onChange={(e) => setWordInput(e.target.value)}
                placeholder="Type a word or phrase, in either language"
                style={{ flex: '1 1 auto' }}
              />
              <button
                type="button"
                className="generate-button"
                onClick={handleGenerateText}
                disabled={!ready || textGenerating || saving}
              >
                {textGenerating ? 'Generating…' : 'Generate text + audio'}
              </button>
            </div>
            <small style={{ display: 'block', marginTop: '0.35rem', opacity: 0.75 }}>
              Fills in the known-language, learning-language and audio fields below - review and edit before adding the note.
            </small>
            {textGenError && <div className="error-message">{textGenError}</div>}
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
              Known-language field
              <select
                value={knownFieldIndex ?? ''}
                onChange={(e) => setKnownFieldIndex(Number(e.target.value))}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              >
                {notetype.fieldNames.map((name, index) => (
                  <option key={name} value={index}>{name}</option>
                ))}
              </select>
            </label>
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
              Write learning-language audio into
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
              Write known-language audio into
              <select
                value={cueAudioFieldIndex ?? ''}
                onChange={(e) => setCueAudioFieldIndex(e.target.value === '' ? null : Number(e.target.value))}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              >
                <option value="">(none - skip the known-language clip)</option>
                {notetype.fieldNames.map((name, index) => (
                  <option key={name} value={index}>{name}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {notetype && (
          <p style={{ opacity: 0.75, marginTop: '-0.5rem', fontSize: '0.85rem' }}>
            {cueAudioFieldIndex !== null
              ? 'Generating audio makes 2 clips per card: the known-language prompt and the learning-language answer. A card with no known-language clip cannot use the amgi Listening template - its prompt side would be silent.'
              : 'Generating audio makes 1 clip per card, in the learning language.'}
          </p>
        )}

        {notetype && (
          <div className="form-group" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <label style={{ flex: '1 1 auto' }}>
              Known language
              <select
                value={knownLanguage}
                onChange={(e) => updateKnownLanguage(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: '0.25rem' }}
              >
                {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
                  <option key={code} value={code}>{flag} {name}</option>
                ))}
              </select>
            </label>
            <label style={{ flex: '1 1 auto' }}>
              Learning language
              <select
                value={learningLanguage}
                onChange={(e) => updateLearningLanguage(e.target.value)}
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

        {mode === 'single' && audioResult && [
          { label: 'Learning-language audio', result: audioResult.target },
          { label: 'Known-language audio', result: audioResult.cue },
        ].filter(({ result }) => result).map(({ label, result }) => (
          <div
            key={label}
            className="error-message"
            style={{ background: 'none', color: result.mocked ? '#d0a030' : '#4caf50', border: `1px solid ${result.mocked ? '#d0a030' : '#4caf50'}` }}
          >
            {label}: {result.mocked
              ? `generated (mocked - ${result.reason})`
              : result.reused
                ? `reused (already generated): ${result.filename}`
                : `generated: ${result.filename}`}
          </div>
        ))}

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
            cueAudioFieldIndex={cueAudioFieldIndex}
            knownFieldIndex={knownFieldIndex}
            knownLanguage={knownLanguage}
            learningLanguage={learningLanguage}
            ready={ready}
          />
        )}
      </form>
    </div>
  );
};

export default CardForm;
