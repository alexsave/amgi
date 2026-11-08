import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import BulkRun from '../../components/Card/BulkRun';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';

// BulkRun under Gemini's per-minute limits. The server's rate gate decides
// every wait (src/server/anki/rateLimit.js); these tests stand in for its
// answers - 429s carrying retryAfterMs, notStarted for a card refused before
// it began, dailyCap for a spent day - and check what the rows do with them,
// on jest's fake timers: no real waiting anywhere.

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
  audio: { filename: `${text}.wav`, reference: `<audio src="${text}.wav"></audio>` },
  cueAudio: { filename: `cue-${text}.wav`, reference: `<audio src="cue-${text}.wav"></audio>` },
});

/** A 429 as ankiApi throws it, from the server's answer. */
const limited = (retryAfterMs, extra = {}) => Object.assign(new Error('Gemini is limiting how many requests gemini-3.8-flash-tts takes per minute.'), { status: 429, retryAfterMs, ...extra });

/** Script generateCardText per line: an array of outcomes (Error to throw, or 'ok'), taken in turn. */
function script(perLine) {
  const calls = {};
  ankiApi.generateCardText.mockImplementation(async (text) => {
    const n = calls[text] || 0;
    calls[text] = n + 1;
    const outcomes = perLine[text] || ['ok'];
    const outcome = outcomes[Math.min(n, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === 'function') return outcome();
    return cardFor(text);
  });
  return calls;
}

function renderRun(lines) {
  const addAnkiNotesBulk = jest.fn(async (deckId, notes) => notes.map((_, n) => ({ ok: true, noteId: 100 + n })));
  useDecks.mockReturnValue({ addAnkiNotesBulk, refreshAnkiDecks: jest.fn(), loadDeckCards: jest.fn() });
  render(<BulkRun deckId="deck1" notetype={notetype} idx={idx} languages={languages} lines={lines} />);
  return { addAnkiNotesBulk };
}

const advance = (ms) => act(async () => { await jest.advanceTimersByTimeAsync(ms); });
const row = (n) => screen.getAllByRole('listitem')[n];
const rowText = (n) => row(n).textContent;
const calledFor = () => ankiApi.generateCardText.mock.calls.map(([text]) => text);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  ankiApi.fieldValuesInDeck.mockResolvedValue({ values: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

test('a started card that hits a long limit waits with a live countdown, then is retried by itself', async () => {
  script({ a: [limited(50_000), 'ok'] });
  renderRun(['a']);
  await advance(0);

  expect(row(0)).toHaveClass('is-waiting');
  expect(rowText(0)).toContain('rate limited');
  expect(rowText(0)).toContain('rate limited, retrying in 50s…');
  expect(screen.getByText(/1 waiting for the rate limit/)).toBeInTheDocument();

  await advance(1000);
  expect(rowText(0)).toContain('retrying in 49s…');
  await advance(10_000);
  expect(rowText(0)).toContain('retrying in 39s…');
  expect(calledFor()).toEqual(['a'], 'nothing is asked again before the wait is over');

  await advance(39_000);
  expect(calledFor()).toEqual(['a', 'a']);
  await advance(3000); // the batch write
  expect(row(0)).toHaveClass('is-done');
  expect(screen.getByText('Done: 1 added')).toBeInTheDocument();
});

test('a card the gate refused to start stays queued, is not failed, and its lane does not take the next line', async () => {
  const refused = limited(20_000, { notStarted: true });
  // Six lines, five lanes: every first try is refused before it starts.
  script({ l1: [refused, 'ok'], l2: [refused, 'ok'], l3: [refused, 'ok'], l4: [refused, 'ok'], l5: [refused, 'ok'], l6: ['ok'] });
  renderRun(['l1', 'l2', 'l3', 'l4', 'l5', 'l6']);
  await advance(0);

  for (let n = 0; n < 5; n += 1) {
    expect(row(n)).toHaveClass('is-queued');
    expect(rowText(n)).toContain('waiting for rate limit, retrying in 20s…');
    expect(rowText(n)).not.toContain('failed');
  }
  expect(calledFor()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5'], 'no lane moved on to l6');
  expect(screen.getByText(/5 waiting for the rate limit/)).toBeInTheDocument();

  // When the countdown ends the lanes start their own lines again.
  await advance(20_000);
  for (const line of ['l1', 'l2', 'l3', 'l4', 'l5']) {
    expect(calledFor().filter((t) => t === line)).toHaveLength(2);
  }
  await advance(5000);
  expect(calledFor().filter((t) => t === 'l6')).toHaveLength(1);
  expect(screen.getByText('Done: 6 added')).toBeInTheDocument();
});

test('a line already in flight is unaffected by another line being refused', async () => {
  let finishA;
  script({
    a: [() => new Promise((resolve) => { finishA = () => resolve(cardFor('a')); })],
    b: [limited(30_000, { notStarted: true }), 'ok'],
  });
  renderRun(['a', 'b']);
  await advance(0);
  expect(row(0)).toHaveClass('is-making');
  expect(row(1)).toHaveClass('is-queued');

  await act(async () => { finishA(); });
  await advance(3000);
  expect(row(0)).toHaveClass('is-done');
  expect(row(1)).toHaveClass('is-queued');
});

test('the budget: a started line waits up to 180 s in total, and is not made to sit through a wait past it', async () => {
  // Just under: 90 s + 89 s = 179 s, both waited out, then made.
  script({ under: [limited(90_000), limited(89_000), 'ok'], over: [limited(90_000), limited(91_000), 'ok'] });
  renderRun(['under', 'over']);
  await advance(0);
  await advance(90_000);
  expect(row(0)).toHaveClass('is-waiting');
  // Just over: 90 s + 91 s = 181 s, so the second wait is refused at once.
  expect(row(1)).toHaveClass('is-error');
  expect(rowText(1)).toContain("Gave up on Gemini's rate limit: this line already waited 90s, and another 91s would pass its 180s limit. Press Retry to try again.");
  expect(within(row(1)).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(calledFor().filter((t) => t === 'over')).toHaveLength(2);

  await advance(89_000);
  await advance(3000);
  expect(row(0)).toHaveClass('is-done');
});

test('a spent daily cap fails that row and every line still waiting, at once, with the same message', async () => {
  const daily = Object.assign(new Error("Your Gemini project's daily limit of 100 requests for gemini-3.8-flash-tts is used up."), { status: 429, dailyCap: true });
  script({ a: [daily], b: [limited(30_000, { notStarted: true })], c: ['ok'], d: ['ok'], e: ['ok'], f: ['ok'], g: ['ok'] });
  renderRun(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  await advance(0);
  await advance(30_000);
  await advance(3000);

  expect(row(0)).toHaveClass('is-error');
  expect(rowText(0)).toContain('daily limit of 100 requests');
  // g was still queued: it is failed with the same message, not attempted.
  expect(row(6)).toHaveClass('is-error');
  expect(rowText(6)).toContain('daily limit of 100 requests');
  expect(calledFor()).not.toContain('g');
  expect(row(1)).toHaveClass('is-error');
});

test('Retry on a failed row runs just that line again', async () => {
  script({ a: [new Error('Failed to generate valid audio for "a" after 3 attempts'), 'ok'], b: ['ok'] });
  renderRun(['a', 'b']);
  await advance(0);
  await advance(3000);
  expect(row(0)).toHaveClass('is-error');
  expect(rowText(0)).toContain('after 3 attempts');
  expect(row(0).querySelector('.bulk-run-cue')).toHaveAttribute('title', 'Failed to generate valid audio for "a" after 3 attempts');

  fireEvent.click(within(row(0)).getByRole('button', { name: 'Retry' }));
  await advance(0);
  await advance(3000);
  expect(calledFor()).toEqual(['a', 'b', 'a']);
  expect(row(0)).toHaveClass('is-done');
});
