import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { runPool } from '../../utils/concurrency';
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

// How many lines are being made at any one moment.
//
// This used to be one - a `for` loop with an await in it - and a line takes
// about five seconds that is almost entirely waiting on a network: the text
// call, then two clip pipelines that each synthesise, transcribe and judge
// the result, with retries. Sixty lines that way is four to six minutes in
// which this app does nothing but wait, one line at a time.
//
// Five rather than "all of them" because a row is not one request: it is
// closer to seven, spread over four different OpenAI models, each with its
// own per-minute allowance. Five lanes over a five-second row settles at
// about one row a second - some sixty text calls, a hundred and twenty
// clips and a hundred and twenty transcriptions in a minute - which leaves
// those allowances room for the retries the audio judge makes on its own.
// Sixty lines fired off at once would instead be four hundred requests in
// flight, most of them refused and retried, and sixty generator subprocesses
// on this machine (see src/server/anki/cardText.js) holding them.
//
// It is also five and not fifty because each finished row writes to Anki
// (see below), and the local bridge answers one collection operation at a
// time - a wide pool would only move the queue from OpenAI's end to Anki's.
const CONCURRENCY = 5;

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

  // Every row update goes through this one functional setState, which is
  // what makes rows safe to finish out of order: each patch is applied to
  // whatever the latest rows are at the moment React runs it, touching only
  // its own index. Building the next rows from a value read outside the
  // updater - `setRows(rows.map(...))` - would have been fine while one row
  // moved at a time and would now drop whichever patches landed in between.
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
      if (superseded()) return;

      // Every already-in-the-deck line is settled here, before the first
      // generation starts, rather than being recognised by whichever lane
      // happened to reach it. Recognising one costs nothing, so there is no
      // reason to spend a lane on it, and a re-paste of a block that is
      // entirely in the deck now resolves in one frame instead of trickling.
      const pending = [];
      queue.forEach((text, i) => {
        if (already.has(text.trim().toLowerCase())) patch(i, { status: 'skipped' });
        else pending.push(i);
      });

      // `pending` holds row indexes, not text, so a row is patched by where
      // it sits in the paste and never by where it sits in the queue of work
      // - the displayed order stays the paste's order however the lanes
      // interleave, and a late row landing cannot overwrite an early one.
      await runPool(pending, CONCURRENCY, async (i) => {
        patch(i, { status: 'making' });
        try {
          const card = await ankiApi.generateCardText(queue[i], languages.known, languages.learning, {
            includeCueAudio: true,
          });
          const fields = notetype.fieldNames.map(() => '');
          if (idx.cue >= 0) fields[idx.cue] = card.front_text;
          if (idx.target >= 0) fields[idx.target] = card.back_text;
          if (idx.targetAudio >= 0) fields[idx.targetAudio] = card.audio?.reference || '';
          if (idx.cueAudio >= 0) fields[idx.cueAudio] = card.cueAudio?.reference || '';
          if (idx.language >= 0) fields[idx.language] = languages.learning;

          // Still one write per card, the moment that card is ready, and
          // deliberately not gathered into a single bulk write at the end:
          // this is what makes closing the tab cost you only the rest of the
          // queue. The writes now overlap, which both transports are built
          // for - the direct one funnels every collection call through one
          // promise chain per collection path (directClient.js), and the
          // bridge hands every one to Anki's own operation queue
          // (bridge_dispatch.py) - so concurrency here queues at the
          // collection, it does not race it.
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
          // Caught inside the lane, so one line that fails costs exactly
          // that line: runPool would otherwise carry the rejection out and
          // leave the summary below unwritten while the other lanes ran on.
          patch(i, { status: 'error', error: err.message });
        }
      }, superseded);

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
