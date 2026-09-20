import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import LANGUAGES from '../../constants/languages';
import { existingKeySet, parseLyricsPaste } from '../../utils/lyricsParse';
import './BulkAddForm.css';

/** All-blank fields for `notetype`, with `text` in `fieldIndex` - one line becomes one note this way. */
function buildFields(notetype, fieldIndex, text) {
  return notetype.fieldNames.map((_name, i) => (i === fieldIndex ? text : ''));
}

const AUDIO_STATUS_LABEL = {
  pending: 'waiting…',
  running: 'generating…',
  done: 'generated',
  mocked: 'generated (mocked)',
  reused: 'reused (already had this clip)',
  error: 'failed',
  cancelled: 'cancelled',
};

/**
 * Paste a block of text (typically song lyrics), get one card per unique
 * line - see the feature's own writeup for the full policy this implements.
 * Deliberately reuses the deck/note type/field-mapping/language pair
 * CardForm.js already has the person choose, rather than asking again: those
 * props are this component's only way to know where a line's text goes.
 */
const BulkAddForm = ({ deckId, notetype, textFieldIndex, audioFieldIndex, cueAudioFieldIndex, knownFieldIndex, knownLanguage, learningLanguage, ready }) => {
  const { addAnkiNotesBulk, updateAnkiNote, refreshAnkiDecks, loadDeckCards } = useDecks();

  // A note type with a CueAudio-like field needs the known-language text to
  // generate that clip from, so generating the other side stops being an
  // optional extra and becomes a prerequisite the moment this field is set -
  // see the cost notice below, which spells out exactly what that adds.
  const cueAudioRequired = cueAudioFieldIndex !== null;

  const [rawText, setRawText] = useState('');
  const [skipSectionMarkers, setSkipSectionMarkers] = useState(true);
  const [preview, setPreview] = useState(null); // { lines: [...], counts... }
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [addedLines, setAddedLines] = useState(null); // [{text, ok, noteId?, warning?, error?}]

  const [audioProgress, setAudioProgress] = useState({}); // noteId -> {status, text, reason, error}
  const [audioRunning, setAudioRunning] = useState(false);
  // Opt-in, off by default: generating the known-language side is one extra
  // text-generation call per card on top of the audio call already listed
  // below, and it is honest to make that an explicit choice rather than
  // something that just happens to a pasted block of dozens of lines.
  const [generateOtherSide, setGenerateOtherSide] = useState(false);
  const cancelRef = useRef(false);
  const abortRef = useRef(null);
  const ownsInput = presetText === undefined;

  const canPreview = ready && notetype && textFieldIndex !== null && rawText.trim().length > 0;

  const runPreview = useCallback(async () => {
    if (!canPreview) return;
    setPreviewLoading(true);
    setPreviewError('');
    setAddedLines(null);
    setAddError('');
    try {
      const parsed = parseLyricsPaste(rawText, { skipSectionMarkers });
      const { values } = await ankiApi.fieldValuesInDeck(deckId, notetype.id, textFieldIndex);
      const existingKeys = existingKeySet(values);
      const lines = parsed.lines.map((line) => ({
        ...line,
        editedText: line.text,
        // Already in the deck: unchecked by default, so re-pasting the same
        // song doesn't silently add a second copy - the person has to
        // deliberately opt a duplicate back in.
        checked: !existingKeys.has(line.key),
        dupInDeck: existingKeys.has(line.key),
      }));
      setPreview({ ...parsed, lines, deckDuplicateCount: lines.filter((l) => l.dupInDeck).length });
    } catch (err) {
      setPreviewError(err.message);
    } finally {
      setPreviewLoading(false);
    }
  }, [canPreview, rawText, skipSectionMarkers, deckId, notetype, textFieldIndex]);

  // Handed text means the person already pressed the button upstairs, so the
  // check against the deck runs straight away rather than behind a second
  // press of a second button.
  const previewRef = useRef(runPreview);
  previewRef.current = runPreview;
  useEffect(() => {
    if (!ownsInput && canPreview) previewRef.current();
  }, [ownsInput, canPreview, rawText]);

  const toggleLine = (index) => {
    setPreview((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === index ? { ...l, checked: !l.checked } : l)),
    }));
  };

  const editLine = (index, value) => {
    setPreview((prev) => ({
      ...prev,
      lines: prev.lines.map((l, i) => (i === index ? { ...l, editedText: value } : l)),
    }));
  };

  const checkedLines = preview ? preview.lines.filter((l) => l.checked) : [];

  const handleAdd = async () => {
    if (checkedLines.length === 0 || !notetype) return;
    setAdding(true);
    setAddError('');
    try {
      const notes = checkedLines.map((line) => ({
        notetypeId: notetype.id,
        fields: buildFields(notetype, textFieldIndex, line.editedText),
        tags: [],
        language: learningLanguage,
        learningFieldIndex: textFieldIndex,
      }));
      const results = await addAnkiNotesBulk(deckId, notes);
      setAddedLines(checkedLines.map((line, i) => ({ text: line.editedText, ...results[i] })));
    } catch (err) {
      setAddError(err.message);
    } finally {
      setAdding(false);
    }
  };

  // Notes that landed successfully and have a field to write a clip into -
  // the audio follow-up pass's own worklist.
  const audioCandidates = (addedLines || [])
    .filter((l) => l.ok && audioFieldIndex !== null)
    .map((l) => ({ noteId: l.noteId, text: l.text }));
  const audioDone = (status) => ['done', 'mocked', 'reused'].includes(status);
  const audioRemaining = audioCandidates.filter((c) => !audioDone(audioProgress[c.noteId]?.status));
  const audioStarted = Object.keys(audioProgress).length > 0;

  // Whichever of the two clips a run produced, folded into one status: worse
  // wins, so "one clip mocked, the other real" still surfaces as mocked
  // rather than quietly reporting "done".
  const combinedAudioStatus = (...results) => {
    const present = results.filter(Boolean);
    if (present.some((r) => r.mocked)) return 'mocked';
    if (present.some((r) => r.reused)) return 'reused';
    return 'done';
  };

  // Text and audio still go out as one call each per card whenever the other
  // side is being generated too - the model's spoken_reading only exists in
  // that text-generation response, and generateCardText already produces the
  // audio in the same pass so that reading actually reaches the synthesiser
  // (see src/server/anki/cardText.js). The pasted line itself is left
  // untouched in textFieldIndex either way, so a lyric stays exactly what was
  // pasted even if the model would have "corrected" it slightly.
  const runAudioGeneration = async () => {
    const effectiveGenerateOtherSide = generateOtherSide || cueAudioRequired;
    setAudioRunning(true);
    cancelRef.current = false;
    for (const candidate of audioRemaining) {
      if (cancelRef.current) break;
      setAudioProgress((prev) => ({ ...prev, [candidate.noteId]: { status: 'running', text: candidate.text } }));
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        if (effectiveGenerateOtherSide && knownFieldIndex !== null) {
          const card = await ankiApi.generateCardText(candidate.text, knownLanguage, learningLanguage, {
            signal: controller.signal,
            includeCueAudio: cueAudioRequired,
          });
          const fields = notetype.fieldNames.map((_name, i) => {
            if (i === audioFieldIndex) return card.audio?.reference || '';
            if (i === textFieldIndex) return candidate.text;
            if (i === knownFieldIndex) return card.front_text;
            if (cueAudioRequired && i === cueAudioFieldIndex) return card.cueAudio?.reference || '';
            return '';
          });
          await updateAnkiNote(candidate.noteId, fields, { language: learningLanguage, learningFieldIndex: textFieldIndex });
          setAudioProgress((prev) => ({
            ...prev,
            [candidate.noteId]: {
              status: combinedAudioStatus(card.audio, card.cueAudio),
              text: candidate.text,
              reason: card.audio?.reason || card.cueAudio?.reason,
            },
          }));
        } else {
          const result = await ankiApi.generateAudio(candidate.text, learningLanguage, { signal: controller.signal });
          const fields = notetype.fieldNames.map((_name, i) => {
            if (i === audioFieldIndex) return result.reference;
            if (i === textFieldIndex) return candidate.text;
            return '';
          });
          await updateAnkiNote(candidate.noteId, fields, { language: learningLanguage, learningFieldIndex: textFieldIndex });
          setAudioProgress((prev) => ({
            ...prev,
            [candidate.noteId]: {
              status: result.mocked ? 'mocked' : result.reused ? 'reused' : 'done',
              text: candidate.text,
              reason: result.reason,
            },
          }));
        }
      } catch (err) {
        if (err.name === 'AbortError') {
          setAudioProgress((prev) => ({ ...prev, [candidate.noteId]: { status: 'cancelled', text: candidate.text } }));
          break;
        }
        setAudioProgress((prev) => ({
          ...prev,
          [candidate.noteId]: { status: 'error', text: candidate.text, error: err.message },
        }));
      }
    }
    // One refresh for the whole pass, not one per clip - the same "batch the
    // UI-visible refresh" reasoning the bulk-add endpoint itself is built on.
    // Awaited before audioRunning flips back, so the moment the summary
    // above says "N of N processed" the note list below already agrees -
    // otherwise there is a brief window where the audio panel claims success
    // while the still-stale card list underneath says "no audio yet".
    await Promise.all([refreshAnkiDecks(), loadDeckCards(deckId)]);
    setAudioRunning(false);
  };

  const cancelAudioGeneration = () => {
    cancelRef.current = true;
    abortRef.current?.abort();
  };

  const audioTally = Object.values(audioProgress).reduce((acc, entry) => {
    acc[entry.status] = (acc[entry.status] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="bulk-add-form">
      {ownsInput && (
        <div className="form-group">
          <label htmlFor="bulkLyrics">Paste lines (one card per line)</label>
          <textarea
            id="bulkLyrics"
            value={rawText}
            onChange={(e) => {
              setRawText(e.target.value);
              setPreview(null);
              setAddedLines(null);
            }}
            rows={10}
            placeholder={'Paste a block of text here, one line per card.'}
          />
        </div>
      )}

      <div className="bulk-add-toggle">
        <label>
          <input
            type="checkbox"
            checked={skipSectionMarkers}
            onChange={(e) => {
              setSkipSectionMarkers(e.target.checked);
              setPreview(null);
            }}
          />
          <span>
            Skip bracketed section markers (<code>[Chorus]</code>, <code>[Verse 2]</code>) - they are not language to learn
          </span>
        </label>
      </div>

      {previewError && <div className="error-message">{previewError}</div>}

      {ownsInput && (
        <button
          type="button"
          className="generate-button"
          onClick={runPreview}
          disabled={!canPreview || previewLoading}
        >
          {previewLoading ? 'Checking against the deck…' : 'Preview'}
        </button>
      )}
      {!ownsInput && previewLoading && <p className="card-form-hint">Checking these against the deck…</p>}

      {preview && (
        <div className="bulk-add-preview">
          <p className="bulk-add-summary">
            {preview.totalLines} line{preview.totalLines === 1 ? '' : 's'} pasted
            {preview.blankCount > 0 && ` - ${preview.blankCount} blank dropped`}
            {preview.sectionMarkerCount > 0 && `, ${preview.sectionMarkerCount} section marker${preview.sectionMarkerCount === 1 ? '' : 's'} skipped`}
            {preview.pasteDuplicateCount > 0 && `, ${preview.pasteDuplicateCount} repeat${preview.pasteDuplicateCount === 1 ? '' : 's'} within the paste dropped`}
            {preview.deckDuplicateCount > 0 && `, ${preview.deckDuplicateCount} already in this deck (unchecked below)`}
            {'. '}
            <strong>{checkedLines.length} card{checkedLines.length === 1 ? '' : 's'} will be added.</strong>
          </p>

          <ul className="bulk-add-line-list">
            {preview.lines.map((line, index) => (
              <li key={`${line.key}-${index}`} className={line.dupInDeck ? 'bulk-add-line-dup' : ''}>
                <input type="checkbox" checked={line.checked} onChange={() => toggleLine(index)} />
                <input
                  type="text"
                  className="bulk-add-line-text"
                  value={line.editedText}
                  onChange={(e) => editLine(index, e.target.value)}
                />
                {line.occurrences > 1 && <span className="bulk-add-badge" title="times this line repeated in the paste">×{line.occurrences}</span>}
                {line.dupInDeck && <span className="bulk-add-badge bulk-add-badge-dup">already in deck</span>}
              </li>
            ))}
          </ul>

          {addError && <div className="error-message">{addError}</div>}

          {!addedLines && (
            <button
              type="button"
              className="generate-button"
              onClick={handleAdd}
              disabled={!ready || adding || checkedLines.length === 0}
            >
              {adding ? 'Adding…' : `Add ${checkedLines.length} card${checkedLines.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      )}

      {addedLines && (
        <div className="bulk-add-results">
          <h4>
            {addedLines.filter((l) => l.ok).length} of {addedLines.length} added
          </h4>
          <ul className="bulk-add-line-list">
            {addedLines.map((line, index) => (
              <li key={index} className={line.ok ? '' : 'bulk-add-line-failed'}>
                <span className="bulk-add-result-text">{line.text}</span>
                {line.ok
                  ? (line.warning
                    ? <span className="bulk-add-badge bulk-add-badge-warning">{line.warning}</span>
                    : <span className="bulk-add-badge bulk-add-badge-ok">added</span>)
                  : <span className="bulk-add-badge bulk-add-badge-failed">{line.error}</span>}
              </li>
            ))}
          </ul>

          {audioCandidates.length > 0 && (
            <div className="bulk-add-audio">
              <h4>Audio</h4>
              {!audioStarted && cueAudioRequired && (
                <p className="bulk-add-cost-notice">
                  This note type has a known-language audio field (CueAudio on the amgi Listening template) - a card
                  with no clip there is silent on its prompt side and cannot use that template. Generating it needs
                  the {LANGUAGES[knownLanguage]?.name || knownLanguage} text too, so this is generated for every card
                  below, not offered as an optional extra.
                </p>
              )}
              {!audioStarted && !cueAudioRequired && knownFieldIndex !== null && (
                <label className="bulk-add-toggle">
                  <input
                    type="checkbox"
                    checked={generateOtherSide}
                    onChange={(e) => setGenerateOtherSide(e.target.checked)}
                  />
                  <span>
                    Also generate the {LANGUAGES[knownLanguage]?.name || knownLanguage} side for each card - one extra
                    text-generation call per card, on top of the audio call below. Off by default.
                  </span>
                </label>
              )}
              {!audioStarted && (
                <p className="bulk-add-cost-notice">
                  {cueAudioRequired
                    ? `Generating text and both audio clips together calls this app's local generator three times per card without audio yet - ${audioCandidates.length} text call${audioCandidates.length === 1 ? '' : 's'} plus ${audioCandidates.length * 2} audio call${audioCandidates.length * 2 === 1 ? '' : 's'} (one ${LANGUAGES[knownLanguage]?.name || knownLanguage} clip and one ${LANGUAGES[learningLanguage]?.name || learningLanguage} clip per card - cost doubles versus a single-clip note type). Text generation needs a real OpenAI API key; without one this step fails per card rather than falling back to a mock. Clip files are content-hashed, so re-running this after a cancel never regenerates a clip it already made.`
                    : (generateOtherSide && knownFieldIndex !== null
                      ? `Generating the ${LANGUAGES[knownLanguage]?.name || knownLanguage} side and audio together calls this app's local generator twice per card without audio yet - ${audioCandidates.length} text call${audioCandidates.length === 1 ? '' : 's'} plus ${audioCandidates.length} audio call${audioCandidates.length === 1 ? '' : 's'}. Generating them together (rather than audio alone) is what lets the audio use the reading the text call produces - the same reason the single-note form does both in one pass. Text generation needs a real OpenAI API key; without one this step fails per card rather than falling back to a mock. Clip files are content-hashed, so re-running this after a cancel never regenerates a clip it already made.`
                      : `Generating audio calls this app's local clip generator once per card without audio yet - ${audioCandidates.length} call${audioCandidates.length === 1 ? '' : 's'} in total. Without an OpenAI API key configured, each call produces a clearly-marked mock clip instead of real audio (safe to try, no cost). With a key configured, each call may use paid API quota - review the count above before starting. Clip files are content-hashed, so re-running this after a cancel never regenerates a clip it already made.`)}
                </p>
              )}
              <div className="bulk-add-audio-controls">
                {!audioRunning && audioRemaining.length > 0 && (
                  <button type="button" className="generate-button" onClick={runAudioGeneration}>
                    {audioStarted ? `Resume audio (${audioRemaining.length} left)` : `Generate audio for ${audioCandidates.length} card${audioCandidates.length === 1 ? '' : 's'}`}
                  </button>
                )}
                {audioRunning && (
                  <button type="button" className="generate-button" onClick={cancelAudioGeneration}>
                    Cancel
                  </button>
                )}
              </div>
              {audioStarted && (
                <p className="bulk-add-summary">
                  {audioRunning
                    ? `Generating… ${Object.keys(audioProgress).length} of ${audioCandidates.length} processed`
                    : (
                      <>
                        {Object.keys(audioProgress).length} of {audioCandidates.length} processed
                        {audioTally.error > 0 && ` - ${audioTally.error} failed`}
                        {audioTally.cancelled > 0 && ' - cancelled'}
                      </>
                    )}
                </p>
              )}
              {audioStarted && (
                <ul className="bulk-add-line-list">
                  {audioCandidates.map((c) => {
                    const status = audioProgress[c.noteId]?.status;
                    if (!status) return null;
                    return (
                      <li key={c.noteId}>
                        <span className="bulk-add-result-text">{c.text}</span>
                        <span className={`bulk-add-badge ${status === 'error' ? 'bulk-add-badge-failed' : ''}`}>
                          {AUDIO_STATUS_LABEL[status] || status}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BulkAddForm;
