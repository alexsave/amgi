import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { existingKeySet } from '../../utils/lyricsParse';
import AudioChip from './AudioChip';
import './BulkRun.css';

// Many cards, made exactly the way one card is made.
//
// What this replaced had three presses and three phases: preview the paste,
// "Add N cards" (which wrote blank notes with only the pasted line in them),
// and then "Generate audio" as a separate run over those notes. That is three
// decisions for one intention, and the middle phase could leave a deck full
// of text-only notes if you wandered off.
//
// It also produced a bug worth recording, because unifying the flow is what
// fixes it rather than a patch: that path wrote the PASTED LINE into the
// learning-language field and the model's front_text into the known-language
// field. When the pasted line was already in the learning language and the
// model echoed it back, both fields ended up holding the same sentence - the
// rows in a deck that show Korean on both sides came from there. One card
// and many cards now take the identical route, where both sides come from
// the model's own answer and the row is flagged if they come back the same.
//
// A card is written to Anki the moment it is finished, so closing the tab
// costs you the rest of the queue and nothing that is already made.

const STATUS_LABEL = {
  queued: 'queued',
  making: 'making…',
  done: 'in the deck',
  skipped: 'already here',
  error: 'failed',
};

const BulkRun = ({ deckId, notetype, idx, languages, lines, onFinished }) => {
  const { addAnkiNote, refreshAnkiDecks, loadDeckCards } = useDecks();
  // The work is captured once, at mount. `lines` is a fresh array on every
  // render of the parent, so depending on it would restart the queue every
  // time anything else on the page changed.
  const [queue] = useState(() => lines);
  const [rows, setRows] = useState(() => queue.map((text) => ({ text, status: 'queued' })));
  const [running, setRunning] = useState(true);
  // A token per run rather than a cancelled flag. React's StrictMode runs an
  // effect, then its cleanup, then the effect again, on the SAME instance -
  // so a cleanup that set `cancelled = true` stopped the only run there was,
  // and a `started` ref then refused to begin another. Every row sat at
  // "queued" forever, in development only. A token lets the second run
  // supersede the first instead: whichever run is current finishes, and any
  // earlier one notices it has been replaced and stops.
  const runId = useRef(0);

  const patch = useCallback((index, next) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...next } : row)));
  }, []);

  useEffect(() => {
    const myRun = runId.current + 1;
    runId.current = myRun;
    const superseded = () => runId.current !== myRun;

    (async () => {
      // Skip what the deck already has, without making it a question: a
      // re-paste of the same block is a normal thing to do, and the answer
      // is always "do not add it twice".
      let already = new Set();
      try {
        if (idx.target >= 0) {
          const { values } = await ankiApi.fieldValuesInDeck(deckId, notetype.id, idx.target);
          already = existingKeySet(values);
        }
      } catch {
        // A failed dupe check is not a reason to refuse to add cards; the
        // worst case is a duplicate the person can delete from the row.
      }

      for (let i = 0; i < queue.length; i += 1) {
        if (superseded()) return;
        const text = queue[i];
        if (already.has(text.trim().toLowerCase())) {
          patch(i, { status: 'skipped' });
          continue;
        }
        patch(i, { status: 'making' });
        try {
          const card = await ankiApi.generateCardText(text, languages.known, languages.learning, {
            includeCueAudio: true,
          });
          const fields = notetype.fieldNames.map(() => '');
          if (idx.cue >= 0) fields[idx.cue] = card.front_text;
          if (idx.target >= 0) fields[idx.target] = card.back_text;
          if (idx.targetAudio >= 0) fields[idx.targetAudio] = card.audio?.reference || '';
          if (idx.cueAudio >= 0) fields[idx.cueAudio] = card.cueAudio?.reference || '';
          if (idx.language >= 0) fields[idx.language] = languages.learning;

          const result = await addAnkiNote(deckId, {
            notetypeId: notetype.id,
            fields,
            tags: [],
            language: languages.learning,
            learningFieldIndex: idx.target >= 0 ? idx.target : undefined,
          });

          patch(i, {
            status: 'done',
            noteId: result?.noteId ?? null,
            cue: card.front_text,
            target: card.back_text,
            cueAudio: card.cueAudio?.filename || '',
            targetAudio: card.audio?.filename || '',
            // The two sides coming back identical means the model did not
            // translate - it echoed. The card is still written, because
            // losing work silently is worse, but it is called out so it can
            // be fixed from the row rather than found months later in a
            // review.
            sameBothSides: card.front_text.trim() === card.back_text.trim(),
          });
        } catch (err) {
          patch(i, { status: 'error', error: err.message });
        }
      }

      if (superseded()) return;
      setRunning(false);
      refreshAnkiDecks();
      loadDeckCards(deckId, { offset: 0, limit: 20 });
      if (onFinished) onFinished();
    })();
    // Deliberately runs once, on mount: the queue is fixed at that point and
    // every other value it needs is captured with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = rows.filter((r) => r.status === 'done').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const failed = rows.filter((r) => r.status === 'error').length;

  return (
    <div className="bulk-run">
      <p className="bulk-run-head">
        {running
          ? `Making ${rows.length} card${rows.length === 1 ? '' : 's'}…`
          : `Done: ${done} added`}
        {!running && skipped > 0 && `, ${skipped} already in the deck`}
        {!running && failed > 0 && `, ${failed} failed`}
      </p>

      <ol className="bulk-run-rows">
        {rows.map((row, i) => (
          <li key={`${row.text}-${i}`} className={`bulk-run-row is-${row.status}`}>
            <span className="bulk-run-state">{STATUS_LABEL[row.status]}</span>
            <span className="bulk-run-text">{row.target || row.text}</span>
            <span className="bulk-run-cue">
              {row.sameBothSides ? 'both sides came back the same - open it and fix the wording' : row.cue || row.error || ''}
            </span>
            <span className="bulk-run-clips">
              <AudioChip filename={row.cueAudio} label={languages.knownName} tone="cue" />
              <AudioChip filename={row.targetAudio} label={languages.learningName} tone="target" />
            </span>
          </li>
        ))}
      </ol>

    </div>
  );
};

export default BulkRun;
