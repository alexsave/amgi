import React, { StrictMode } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import BulkRun from '../../components/Card/BulkRun';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';

jest.mock('../../contexts/DeckContext');
jest.mock('../../utils/ankiApi', () => ({
  ankiApi: {
    fieldValuesInDeck: jest.fn(),
    generateCardText: jest.fn(),
    mediaBlob: jest.fn(),
  },
}));

const notetype = { id: 1, fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language'] };
const idx = { cue: 0, cueAudio: 1, target: 2, targetAudio: 3, language: 4 };
const languages = { known: 'en', learning: 'ko', knownName: 'English', learningName: 'Korean' };

const cardFor = (text) => ({
  front_text: `cue for ${text}`,
  back_text: text,
  audio: { filename: `${text}.mp3`, reference: `<audio src="${text}.mp3"></audio>` },
  cueAudio: { filename: `cue-${text}.mp3`, reference: `<audio src="cue-${text}.mp3"></audio>` },
});

const renderRun = (lines, { strict = false, onFinished } = {}) => {
  // One result slot per note, the shape both transports' addNotesBulk
  // returns (see plusaudio/lib/collection/notes.js).
  const addAnkiNotesBulk = jest.fn(async (deckId, notes) => notes.map((_, n) => ({ ok: true, noteId: 100 + n })));
  const refreshAnkiDecks = jest.fn();
  const loadDeckCards = jest.fn();
  useDecks.mockReturnValue({ addAnkiNotesBulk, refreshAnkiDecks, loadDeckCards });

  const run = (
    <BulkRun
      deckId="deck1"
      notetype={notetype}
      idx={idx}
      languages={languages}
      lines={lines}
      onFinished={onFinished}
    />
  );
  render(strict ? <StrictMode>{run}</StrictMode> : run);
  return { addAnkiNotesBulk, refreshAnkiDecks, loadDeckCards };
};

/** Every note actually written, across however many batches it took. */
const notesWritten = (addAnkiNotesBulk) => addAnkiNotesBulk.mock.calls.flatMap(([, notes]) => notes);

/** Let every pending microtask and the effect's own awaits settle. */
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });

const rowStates = () => screen.getAllByRole('listitem').map((row) => within(row).getAllByText(/./)[0].textContent);

beforeEach(() => {
  jest.clearAllMocks();
  ankiApi.fieldValuesInDeck.mockResolvedValue({ values: [] });
  ankiApi.generateCardText.mockImplementation(async (text) => cardFor(text));
});

describe('making many cards from a paste', () => {
  test('makes several lines at once instead of one at a time', async () => {
    // The whole point of the change this guards: every line is several
    // seconds of waiting on OpenAI, and a strictly sequential run spent all
    // of it idle. Five is BulkRun's own CONCURRENCY.
    const gates = new Map();
    ankiApi.generateCardText.mockImplementation((text) => new Promise((resolve) => {
      gates.set(text, () => resolve(cardFor(text)));
    }));
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);

    renderRun(lines);
    await waitFor(() => expect(ankiApi.generateCardText).toHaveBeenCalledTimes(5));

    // Still five once everything that could run has run: the pool is bounded,
    // not "fire all twelve and hope".
    await settle();
    expect(ankiApi.generateCardText).toHaveBeenCalledTimes(5);

    // A lane freeing up takes the next line rather than the run waiting for
    // the whole batch of five.
    await act(async () => { gates.get('line 0')(); });
    await waitFor(() => expect(ankiApi.generateCardText).toHaveBeenCalledTimes(6));

    // Opening every gate there is, round after round, because each one that
    // opens lets a lane pick up a line that has no gate yet.
    await act(async () => {
      for (let round = 0; round < 12; round += 1) {
        gates.forEach((open) => open());
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    });
    await waitFor(() => expect(ankiApi.generateCardText).toHaveBeenCalledTimes(12));
    expect(screen.getByText('Done: 12 added')).toBeInTheDocument();
  });

  test('a finished card is written without waiting for the rest of the queue', async () => {
    // The durability property this screen is built around, now that writes
    // are batched: a card that is made while the others are still being made
    // is in the deck within one flush window, not at the end of the run.
    // 3000 is BulkRun's own FLUSH_MS.
    jest.useFakeTimers();
    try {
      const gates = new Map();
      ankiApi.generateCardText.mockImplementation((text) => new Promise((resolve) => {
        gates.set(text, () => resolve(cardFor(text)));
      }));

      const { addAnkiNotesBulk } = renderRun(['a', 'b', 'c']);
      await waitFor(() => expect(ankiApi.generateCardText).toHaveBeenCalledTimes(3));
      expect(addAnkiNotesBulk).not.toHaveBeenCalled();

      await act(async () => { gates.get('b')(); });
      await act(async () => { await jest.advanceTimersByTimeAsync(3000); });

      // One card written, on its own, while the other two are still being
      // made - closing the tab now costs only the rest of the queue.
      expect(addAnkiNotesBulk).toHaveBeenCalledTimes(1);
      const notes = notesWritten(addAnkiNotesBulk);
      expect(notes).toHaveLength(1);
      expect(notes[0].fields[idx.target]).toBe('b');
      expect(rowStates()).toEqual(['making…', 'in the deck', 'making…']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('cards that finish together are written as one call, not one call each', async () => {
    // The amplification this replaced: one write per card, each of which
    // re-read the deck list and the open deck's page (DeckContext), so a
    // sixty line paste was a hundred and eighty collection operations. Ten
    // is BulkRun's own FLUSH_SIZE, so twelve lines that all finish at once
    // are a full batch and then the remaining two.
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    const { addAnkiNotesBulk } = renderRun(lines);

    await waitFor(() => expect(screen.getByText('Done: 12 added')).toBeInTheDocument());
    expect(addAnkiNotesBulk).toHaveBeenCalledTimes(2);
    expect(addAnkiNotesBulk.mock.calls.map(([, notes]) => notes.length)).toEqual([10, 2]);
    expect(notesWritten(addAnkiNotesBulk).map((note) => note.fields[idx.target])).toEqual(lines);
  });

  test('a batch that fails to write costs exactly the rows in it', async () => {
    const { addAnkiNotesBulk } = renderRun(['a', 'b']);
    addAnkiNotesBulk.mockRejectedValueOnce(new Error('Anki went away'));

    await waitFor(() => expect(screen.getByText(/2 failed/)).toBeInTheDocument());
    expect(rowStates()).toEqual(['failed', 'failed']);
    // Not left at "making…" forever, which is what a swallowed write error
    // would look like on screen.
    expect(screen.getAllByText('Anki went away')).toHaveLength(2);
  });

  test('one bad note in a batch does not take the rest of the batch with it', async () => {
    // Both transports' addNotesBulk report a bad note in its own result slot
    // and add the others anyway - the row has to say the same.
    const { addAnkiNotesBulk } = renderRun(['a', 'b', 'c']);
    addAnkiNotesBulk.mockResolvedValueOnce([
      { ok: true, noteId: 1 },
      { ok: false, error: 'note type "Basic" has 2 fields, got 5' },
      { ok: true, noteId: 3 },
    ]);

    await waitFor(() => expect(screen.getByText(/Done: 2 added/)).toBeInTheDocument());
    expect(rowStates()).toEqual(['in the deck', 'failed', 'in the deck']);
    expect(screen.getByText('note type "Basic" has 2 fields, got 5')).toBeInTheDocument();
  });

  test('rows keep the order of the paste however the lanes finish', async () => {
    const gates = new Map();
    ankiApi.generateCardText.mockImplementation((text) => new Promise((resolve) => {
      gates.set(text, () => resolve(cardFor(text)));
    }));

    renderRun(['first', 'second', 'third']);
    await waitFor(() => expect(ankiApi.generateCardText).toHaveBeenCalledTimes(3));

    // Backwards, which is exactly what a pool does when the third line is
    // shorter than the first.
    await act(async () => { gates.get('third')(); });
    await act(async () => { gates.get('first')(); });
    await act(async () => { gates.get('second')(); });

    await waitFor(() => expect(screen.getByText('Done: 3 added')).toBeInTheDocument());
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows[0]).toContain('first');
    expect(rows[1]).toContain('second');
    expect(rows[2]).toContain('third');
    expect(rows[0]).toContain('cue for first');
  });

  test('skips what the deck already has before making anything', async () => {
    ankiApi.fieldValuesInDeck.mockResolvedValue({ values: ['already there'] });

    const { addAnkiNotesBulk } = renderRun(['already there', 'new one']);
    await waitFor(() => expect(screen.getByText(/Done: 1 added/)).toBeInTheDocument());

    expect(ankiApi.generateCardText).toHaveBeenCalledTimes(1);
    expect(ankiApi.generateCardText.mock.calls[0][0]).toBe('new one');
    expect(notesWritten(addAnkiNotesBulk)).toHaveLength(1);
    expect(rowStates()).toEqual(['already here', 'in the deck']);
    expect(screen.getByText(/1 already in the deck/)).toBeInTheDocument();
  });

  test('one line failing costs only that line', async () => {
    ankiApi.generateCardText.mockImplementation(async (text) => {
      if (text === 'bad') throw new Error('the model refused');
      return cardFor(text);
    });

    const { addAnkiNotesBulk } = renderRun(['good 1', 'bad', 'good 2']);
    await waitFor(() => expect(screen.getByText(/Done: 2 added/)).toBeInTheDocument());

    expect(notesWritten(addAnkiNotesBulk).map((note) => note.fields[idx.target])).toEqual(['good 1', 'good 2']);
    expect(rowStates()).toEqual(['in the deck', 'failed', 'in the deck']);
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText('the model refused')).toBeInTheDocument();
  });

  test('flags a card whose two sides came back the same', async () => {
    ankiApi.generateCardText.mockImplementation(async (text) => ({ ...cardFor(text), front_text: text }));

    renderRun(['안녕하세요']);
    await waitFor(() => expect(screen.getByText(/Done: 1 added/)).toBeInTheDocument());
    expect(screen.getByText(/both sides came back the same/)).toBeInTheDocument();
  });

  test('finishes the run once, after everything has settled', async () => {
    const onFinished = jest.fn();
    const { refreshAnkiDecks, loadDeckCards } = renderRun(['a', 'b', 'c'], { onFinished });

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(refreshAnkiDecks).toHaveBeenCalledTimes(1);
    expect(loadDeckCards).toHaveBeenCalledWith('deck1', { offset: 0, limit: 20 });
    expect(loadDeckCards).toHaveBeenCalledTimes(1);

    await settle();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  test('a second run supersedes the first instead of deadlocking it', async () => {
    // StrictMode runs effect, cleanup, effect on the same instance. The run
    // token is what stops that leaving every row at "queued" forever, and
    // what stops the superseded run doing the work twice.
    const onFinished = jest.fn();
    const { addAnkiNotesBulk } = renderRun(['a', 'b'], { strict: true, onFinished });

    await waitFor(() => expect(screen.getByText('Done: 2 added')).toBeInTheDocument());
    expect(rowStates()).toEqual(['in the deck', 'in the deck']);
    expect(notesWritten(addAnkiNotesBulk).map((note) => note.fields[idx.target])).toEqual(['a', 'b']);
    expect(ankiApi.generateCardText).toHaveBeenCalledTimes(2);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  test('a failed dupe check does not stop the run', async () => {
    ankiApi.fieldValuesInDeck.mockRejectedValue(new Error('Anki went away'));

    const { addAnkiNotesBulk } = renderRun(['a', 'b']);
    await waitFor(() => expect(screen.getByText('Done: 2 added')).toBeInTheDocument());
    expect(notesWritten(addAnkiNotesBulk)).toHaveLength(2);
  });

  test('skips a line the deck already has whatever its case or trailing punctuation', async () => {
    // The dupe check reads the deck through normalizeForDedupe (see
    // lyricsParse.js), which does not fold case and does strip trailing
    // punctuation. BulkRun looked those keys up with
    // `text.trim().toLowerCase()`, so a line with a capital letter in it and
    // a line whose existing note ends in punctuation both missed - and a
    // missed skip is not a cosmetic one: the line is sent to OpenAI again
    // and lands in the deck a second time.
    ankiApi.fieldValuesInDeck.mockResolvedValue({ values: ['Hello there', 'Comment ça va?'] });

    const { addAnkiNotesBulk } = renderRun(['Hello there', 'Comment ça va?', 'hello there', 'new one']);
    await waitFor(() => expect(screen.getByText(/Done: 2 added/)).toBeInTheDocument());

    // The third line is NOT a duplicate: lyricsParse's policy is that case
    // is never folded, so "hello there" and "Hello there" are two lines and
    // this must not become a skip by lowercasing both sides instead.
    expect(rowStates()).toEqual(['already here', 'already here', 'in the deck', 'in the deck']);
    expect(ankiApi.generateCardText.mock.calls.map(([text]) => text)).toEqual(['hello there', 'new one']);
    expect(notesWritten(addAnkiNotesBulk).map((note) => note.fields[idx.target])).toEqual(['hello there', 'new one']);
    expect(screen.getByText(/2 already in the deck/)).toBeInTheDocument();
  });
});
