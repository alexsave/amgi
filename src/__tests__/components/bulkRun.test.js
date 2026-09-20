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
  const addAnkiNote = jest.fn(async () => ({ noteId: 5 }));
  const refreshAnkiDecks = jest.fn();
  const loadDeckCards = jest.fn();
  useDecks.mockReturnValue({ addAnkiNote, refreshAnkiDecks, loadDeckCards });

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
  return { addAnkiNote, refreshAnkiDecks, loadDeckCards };
};

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

  test('writes each card as it is finished rather than batching them', async () => {
    const gates = new Map();
    ankiApi.generateCardText.mockImplementation((text) => new Promise((resolve) => {
      gates.set(text, () => resolve(cardFor(text)));
    }));

    const { addAnkiNote } = renderRun(['a', 'b', 'c']);
    await waitFor(() => expect(ankiApi.generateCardText).toHaveBeenCalledTimes(3));
    expect(addAnkiNote).not.toHaveBeenCalled();

    // One card done means one card in the deck, while the other two are
    // still being made - closing the tab now costs only the rest.
    await act(async () => { gates.get('b')(); });
    await waitFor(() => expect(addAnkiNote).toHaveBeenCalledTimes(1));
    expect(addAnkiNote.mock.calls[0][1].fields[idx.target]).toBe('b');
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

    const { addAnkiNote } = renderRun(['already there', 'new one']);
    await waitFor(() => expect(screen.getByText(/Done: 1 added/)).toBeInTheDocument());

    expect(ankiApi.generateCardText).toHaveBeenCalledTimes(1);
    expect(ankiApi.generateCardText.mock.calls[0][0]).toBe('new one');
    expect(addAnkiNote).toHaveBeenCalledTimes(1);
    expect(rowStates()).toEqual(['already here', 'in the deck']);
    expect(screen.getByText(/1 already in the deck/)).toBeInTheDocument();
  });

  test('one line failing costs only that line', async () => {
    ankiApi.generateCardText.mockImplementation(async (text) => {
      if (text === 'bad') throw new Error('the model refused');
      return cardFor(text);
    });

    const { addAnkiNote } = renderRun(['good 1', 'bad', 'good 2']);
    await waitFor(() => expect(screen.getByText(/Done: 2 added/)).toBeInTheDocument());

    expect(addAnkiNote).toHaveBeenCalledTimes(2);
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
    const { addAnkiNote } = renderRun(['a', 'b'], { strict: true, onFinished });

    await waitFor(() => expect(screen.getByText('Done: 2 added')).toBeInTheDocument());
    expect(rowStates()).toEqual(['in the deck', 'in the deck']);
    expect(addAnkiNote).toHaveBeenCalledTimes(2);
    expect(ankiApi.generateCardText).toHaveBeenCalledTimes(2);
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  test('a failed dupe check does not stop the run', async () => {
    ankiApi.fieldValuesInDeck.mockRejectedValue(new Error('Anki went away'));

    const { addAnkiNote } = renderRun(['a', 'b']);
    await waitFor(() => expect(screen.getByText('Done: 2 added')).toBeInTheDocument());
    expect(addAnkiNote).toHaveBeenCalledTimes(2);
  });
});
