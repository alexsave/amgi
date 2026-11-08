import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { runPool } from '../../utils/concurrency';
import { existingLineKeys, isAlreadyInDeck } from '../../utils/deckDupes';
import { MAX_WAIT_MS } from 'plusaudio/lib/rateLimits';
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
// A card is written to Anki within seconds of being finished, so closing the
// tab costs you the rest of the queue and almost nothing that is already
// made. See FLUSH_SIZE/FLUSH_MS below for what "almost" is worth and why it
// is not "nothing at all" any more.

const STATUS_LABEL = {
  queued: 'queued',
  making: 'making…',
  waiting: 'rate limited',
  done: 'in the deck',
  skipped: 'already here',
  error: 'failed',
};

// GEMINI'S LIMITS. One key is one per-minute allowance per model, shared by
// every card being made. The ONE owner of when a request may go is the rate
// gate in the server (plusaudio/lib/rateGate.js, answered through
// src/server/anki/rateLimit.js); this screen keeps no timing of its own. A
// 429 carries the gate's own jittered wait, and a line here waits exactly
// that long before asking again - the countdown on the row is only a display
// of that number, ticking down once a second. Two kinds of answer:
//
//   - notStarted: the gate refused to START a new card while a model is
//     blocked. The line was never begun, so it stays `queued`, costs no
//     attempt and none of its budget, and its lane waits for it rather than
//     taking the next line (which would only be refused too).
//   - a started card hit a long limit mid-way: the row is `waiting` and
//     counts that wait against RATE_LIMIT_BUDGET_MS.
//
// THE BUDGET is the sum of the waits a STARTED line has been told to make.
// Waits before a line starts are not counted, or a long queue would time out
// rows that never began. It is the same number as the gate's longest
// backoff (MAX_WAIT_MS), so the two cannot disagree. A wait that would take
// a line past it ends the line at once as an error with a Retry button,
// rather than sitting through a wait it would then give up on. Retry starts
// the line again with a fresh budget.
//
// A spent DAILY cap is not a wait: the row says so, and every line still
// queued or waiting says so at once, instead of each failing in turn.
const RATE_LIMIT_BUDGET_MS = MAX_WAIT_MS;

const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The countdown a row shows while its line waits for Gemini's rate limit. */
const waitNote = (row) => {
  if (row.waitLeft > 0) {
    return row.status === 'waiting'
      ? `rate limited, retrying in ${row.waitLeft}s…`
      : `waiting for rate limit, retrying in ${row.waitLeft}s…`;
  }
  return row.status === 'waiting' ? 'rate limited, retrying…' : '';
};

/**
 * What a row says in its right-hand column, in order of what the person
 * needs to know first.
 *
 * The order matters now that a row can hold a cue AND an error at once: the
 * card's text is put on the row as soon as the model answers, and the note
 * is written a moment later in a batch (see FLUSH_SIZE below), so a row
 * whose write failed still has a perfectly good cue on it. Showing the cue
 * there - which a plain `row.cue || row.error` did - hid the only thing that
 * had gone wrong behind the one thing that had gone right.
 */
const rowNote = (row) => {
  if (row.status === 'error') return row.error || '';
  if (row.status === 'waiting' || row.waitLeft > 0) return waitNote(row);
  if (row.sameBothSides) return 'both sides came back the same - open it and fix the wording';
  return row.cue || '';
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
// five to seven, spread over two Gemini models (gemini-3.8-flash for the
// text, transcriptions and judging; gemini-3.8-flash-tts for speech), each
// with its own per-minute allowance. Sixty lines fired off at once would be
// four hundred requests in flight and sixty generator subprocesses on this
// machine (see src/server/anki/cardText.js) holding them.
//
// Five lanes are NOT what keeps a run under Gemini's limits - the server's
// rate gate is (see GEMINI'S LIMITS above). Measured on the owner's billed
// Tier 1 project (2026-11-08), a TTS model refused after 10 to 16 requests
// in a rolling minute; at two clips a card that is about five to seven
// cards a minute, whatever the lane count - one lane alone would ask for
// more. On that tier the gate paces the lanes and they spend most of a busy
// minute waiting; five lanes still pay off on a higher tier, and the gate
// makes the extra lanes cost nothing but a refused admission.
//
// It is also five and not fifty because finished rows are written to Anki as
// they come (see below), and the local bridge answers one collection
// operation at a time - a wide pool would only move the queue from Gemini's
// end to Anki's.
const CONCURRENCY = 5;

// How finished cards get from a lane into the collection: in small batches,
// on a deadline.
//
// One write per finished card was three Anki round trips per line, because
// DeckContext.addAnkiNote re-reads the deck list AND the open deck's first
// page after every single note it writes. A sixty line paste therefore cost
// a hundred and eighty collection operations, about 1.24s of the bridge
// doing nothing else, where one addNotesBulk of all sixty notes is 75ms.
// Nearly all of that was the refreshes, not the writes: the deck list was
// re-fetched sixty times to be looked at once, at the end.
//
// Buffering the whole run and writing it once at the end is the obvious
// collapse, and it is rejected: it would take away the property this screen
// is built around (see the top of this file), that a card is in your deck
// the moment it is made. A six minute run interrupted at minute five would
// leave nothing behind at all, which is a far worse failure than the one
// being fixed.
//
// So a finished card waits in a buffer that is written out when it holds
// FLUSH_SIZE cards, or FLUSH_MS after the FIRST card entered it, whichever
// comes first. A deadline from the oldest unwritten card, deliberately not a
// debounce re-armed by each new arrival: under a steady stream of finishing
// cards - which is exactly what five lanes produce - a debounce would never
// fire, and the run would degenerate into the single end-of-run write this
// rejected.
//
// WORST CASE LOSS, closing the tab mid-run: whatever finished in the last
// FLUSH_MS, and never more than FLUSH_SIZE - 1 cards. Five lanes over a five
// second row finish about one card a second, so in practice about three -
// against the rest of the queue, which was always going to be lost anyway.
// Sixty lines go from a hundred and eighty round trips to about twenty.
//
// Batches are chained rather than fired off as they are cut, so a slow
// collection can never have two batches of the same run in flight: the
// second would only queue behind the first at the bridge anyway (see
// CONCURRENCY above), and chaining keeps the rows reaching "in the deck" in
// the order the cards were actually written.
const FLUSH_SIZE = 10;
const FLUSH_MS = 3000;

const BulkRun = ({ deckId, notetype, idx, languages, lines, onFinished }) => {
  const { addAnkiNotesBulk, refreshAnkiDecks, loadDeckCards } = useDecks();
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
  // The daily cap's message once one is hit: nothing more is started this run.
  const dailyCapHit = useRef('');
  // The current run's line runner and buffer flush, for the Retry button.
  const lineRunner = useRef(null);

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
        // Both sides of every card, not just the learning side: a pasted
        // line is as often the known-language side (see deckDupes.js).
        already = await existingLineKeys(deckId, notetype.id, idx);
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
        // normalizeForDedupe on both sides (isAlreadyInDeck), which is the whole point of that
        // function living in one place. This used to look up
        // `text.trim().toLowerCase()` against a set whose keys were built by
        // normalizeForDedupe - which trims and collapses whitespace and
        // strips trailing punctuation, and deliberately never folds case
        // (see lyricsParse.js's policy). So every line with a capital letter
        // in it, and every line whose existing note ends in a comma or a
        // full stop, missed the set it was being checked against: the skip
        // silently did nothing, the line was generated again at the API's
        // expense, and the deck got a second copy of a card it already had.
        if (isAlreadyInDeck(already, text)) patch(i, { status: 'skipped' });
        else pending.push(i);
      });

      // The write side of the run - see FLUSH_SIZE/FLUSH_MS above.
      const buffered = [];
      let deadline = null;
      let writes = Promise.resolve();

      const writeBatch = async (batch) => {
        try {
          // `refresh: false`: this run refreshes once, below, when the last
          // batch has landed. Letting the context refresh per batch would
          // put back a smaller copy of the exact amplification batching is
          // here to remove.
          const results = await addAnkiNotesBulk(deckId, batch.map((entry) => entry.note), { refresh: false });
          batch.forEach((entry, n) => {
            // Per-note results, because the bulk write isolates a bad note
            // instead of failing the batch around it (see
            // plusaudio/lib/collection/notes.js's addNotesBulk and
            // bridge_ops.add_notes_bulk, which agree on that contract): a
            // note type that changed under the run costs its own row and no
            // other, exactly as one bad line did when each card was written
            // on its own.
            const result = results?.[n];
            if (result && result.ok === false) patch(entry.index, { status: 'error', error: result.error });
            else patch(entry.index, { status: 'done', noteId: result?.noteId ?? null });
          });
        } catch (err) {
          // The call itself failed - the transport, not any one note - so
          // every row in the batch says so rather than sitting at "making"
          // for the rest of the run.
          batch.forEach((entry) => patch(entry.index, { status: 'error', error: err.message }));
        }
      };

      const flush = () => {
        if (deadline) {
          clearTimeout(deadline);
          deadline = null;
        }
        if (buffered.length > 0) {
          const batch = buffered.splice(0, buffered.length);
          writes = writes.then(() => writeBatch(batch));
        }
        // The whole chain, not just this batch: the caller that awaits this
        // at the end of the run wants every batch written, including ones
        // cut before this call.
        return writes;
      };

      const queueWrite = (index, note) => {
        buffered.push({ index, note });
        if (buffered.length >= FLUSH_SIZE) flush();
        else if (!deadline) deadline = setTimeout(flush, FLUSH_MS);
      };

      // `pending` holds row indexes, not text, so a row is patched by where
      // it sits in the paste and never by where it sits in the queue of work
      // - the displayed order stays the paste's order however the lanes
      // interleave, and a late row landing cannot overwrite an early one.
      // One line, start to finish, however many waits it takes. Kept on a
      // ref so the Retry button on a failed row can run it again too.
      const runLine = async (i) => {
        let budgetSpentMs = 0;
        // A line that learns of a spent daily cap - before it starts, or
        // when a wait ends - ends with that message, whatever it was doing.
        const endForDailyCap = () => patch(i, { status: 'error', waitLeft: 0, error: dailyCapHit.current });
        for (;;) {
          if (dailyCapHit.current) {
            endForDailyCap();
            return;
          }
          patch(i, { status: 'making', waitLeft: 0, error: '' });
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

            // What the model produced goes on the row immediately, while the
            // note itself waits for the next batch write: the sentence and its
            // clips are on screen the moment they exist, and only the row's
            // "in the deck" state - which is a claim about the collection -
            // waits until the collection has actually been told.
            patch(i, {
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

            queueWrite(i, {
              notetypeId: notetype.id,
              fields,
              tags: [],
              language: languages.learning,
              learningFieldIndex: idx.target >= 0 ? idx.target : undefined,
            });
            return;
          } catch (err) {
            if (err.dailyCap) {
              stopForDailyCap(i, err.message);
              return;
            }
            if (dailyCapHit.current) {
              endForDailyCap();
              return;
            }
            if (err.status === 429 && Number.isFinite(err.retryAfterMs)) {
              if (err.notStarted) {
                // Never begun: still queued, no attempt, no budget spent.
                patch(i, { status: 'queued', waitLeft: seconds(err.retryAfterMs) });
                await wait(err.retryAfterMs);
                continue;
              }
              if (budgetSpentMs + err.retryAfterMs > RATE_LIMIT_BUDGET_MS) {
                patch(i, {
                  status: 'error',
                  waitLeft: 0,
                  error: `Gave up on Gemini's rate limit: this line already waited ${Math.round(budgetSpentMs / 1000)}s, and another ${seconds(err.retryAfterMs)}s would pass its ${RATE_LIMIT_BUDGET_MS / 1000}s limit. Press Retry to try again.`,
                });
                return;
              }
              budgetSpentMs += err.retryAfterMs;
              patch(i, { status: 'waiting', waitLeft: seconds(err.retryAfterMs) });
              await wait(err.retryAfterMs);
              continue;
            }
            // Caught inside the lane, so one line that fails costs exactly
            // that line: runPool would otherwise carry the rejection out and
            // leave the summary below unwritten while the other lanes ran on.
            patch(i, { status: 'error', waitLeft: 0, error: err.message });
            return;
          }
        }
      };

      // A spent daily cap fails every line still waiting its turn at once,
      // with the same message, instead of each one finding out in turn.
      const stopForDailyCap = (i, message) => {
        dailyCapHit.current = message;
        setRows((prev) => prev.map((row, n) => (
          n === i || row.status === 'queued' || row.status === 'waiting'
            ? { ...row, status: 'error', waitLeft: 0, error: message }
            : row
        )));
      };

      lineRunner.current = { runLine, flush };

      // `pending` holds row indexes, not text, so a row is patched by where
      // it sits in the paste and never by where it sits in the queue of work
      // - the displayed order stays the paste's order however the lanes
      // interleave, and a late row landing cannot overwrite an early one.
      await runPool(pending, CONCURRENCY, runLine, () => superseded() || dailyCapHit.current);

      // Written even if this run has been superseded, and before that check
      // on purpose: a card in the buffer is already made and already paid
      // for, and the buffer is the only place it exists. The per-card write
      // this replaced had the same property for the same reason - a lane
      // still in flight when the run was replaced wrote its card anyway.
      await flush();

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

  // The countdown on waiting rows: a display of the wait the gate gave each
  // line, ticked down once a second. It decides nothing - the line itself
  // wakes when that wait is over (see runLine) - so it cannot disagree with
  // the gate about when anything happens.
  const counting = rows.some((row) => row.waitLeft > 0);
  useEffect(() => {
    if (!counting) return undefined;
    const tick = setInterval(() => {
      setRows((prev) => prev.map((row) => (row.waitLeft > 0 ? { ...row, waitLeft: row.waitLeft - 1 } : row)));
    }, 1000);
    return () => clearInterval(tick);
  }, [counting]);

  // Run one failed line again, with a fresh budget, and write it.
  const retry = async (i) => {
    if (!lineRunner.current) return;
    dailyCapHit.current = '';
    await lineRunner.current.runLine(i);
    await lineRunner.current.flush();
    refreshAnkiDecks();
    loadDeckCards(deckId, { offset: 0, limit: 20 });
  };

  const done = rows.filter((r) => r.status === 'done').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const failed = rows.filter((r) => r.status === 'error').length;
  const waiting = rows.filter((r) => r.status === 'waiting' || r.waitLeft > 0).length;

  return (
    <div className="bulk-run">
      <p className="bulk-run-head">
        {running
          ? `Making ${rows.length} card${rows.length === 1 ? '' : 's'}…`
          : `Done: ${done} added`}
        {running && waiting > 0 && `, ${waiting} waiting for the rate limit`}
        {!running && skipped > 0 && `, ${skipped} already in the deck`}
        {!running && failed > 0 && `, ${failed} failed`}
      </p>

      <ol className="bulk-run-rows">
        {rows.map((row, i) => (
          <li key={`${row.text}-${i}`} className={`bulk-run-row is-${row.status}`}>
            <span className="bulk-run-state">{STATUS_LABEL[row.status]}</span>
            <span className="bulk-run-text">{row.target || row.text}</span>
            <span className="bulk-run-cue" title={rowNote(row) || undefined}>
              {rowNote(row)}
            </span>
            <span className="bulk-run-clips">
              {row.status === 'error' ? (
                <button type="button" className="bulk-run-retry" onClick={() => retry(i)}>Retry</button>
              ) : (
                <>
                  <AudioChip filename={row.cueAudio} label={languages.knownName} tone="cue" />
                  <AudioChip filename={row.targetAudio} label={languages.learningName} tone="target" />
                </>
              )}
            </span>
          </li>
        ))}
      </ol>

    </div>
  );
};

export default BulkRun;
