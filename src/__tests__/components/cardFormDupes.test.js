import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CardForm from '../../components/Card/CardForm';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { existingLineKeys, isAlreadyInDeck } from '../../utils/deckDupes';

// Typing a line that is already a card in the deck must not make it again.
//
// Reproduced in the real app first: "Where is the station?" typed into the
// add box twice made two identical notes, and pasting it again beside a new
// line made a third. The line is the card's known-language side (Cue), and
// nothing compared a typed line against a Cue: the paste path read only the
// learning-language side (Target), and the one-line path checked nothing. One
// line and many now share BulkRun, so deckDupes.js is the only place to ask.

jest.mock('../../contexts/DeckContext');
jest.mock('../../utils/ankiApi', () => ({
  ankiApi: {
    fieldValuesInDeck: jest.fn(),
    generateCardText: jest.fn(),
    mediaBlob: jest.fn(),
  },
}));

const notetype = { id: 7, name: 'amgi Listening', fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'] };
const CUE = 0;
const TARGET = 2;

/** A deck with one card: Cue "Where is the station?", Target "역이 어디예요?". */
function deckWithStationCard() {
  ankiApi.fieldValuesInDeck.mockImplementation(async (deckId, notetypeId, fieldIndex) => ({
    values: fieldIndex === CUE ? ['Where is the station?'] : fieldIndex === TARGET ? ['역이 어디예요?'] : [],
  }));
}

function renderForm() {
  const addAnkiNotesBulk = jest.fn(async (deckId, notes) => notes.map((_, n) => ({ ok: true, noteId: 100 + n })));
  useDecks.mockReturnValue({
    ankiNotetypes: [notetype],
    ensureAnkiNotetypes: jest.fn(),
    addAnkiNotesBulk,
    ankiStatus: { mode: 'direct' },
    refreshAnkiDecks: jest.fn(),
    loadDeckCards: jest.fn(),
  });
  render(<CardForm deckId="deck1" languages={{ known: 'en', learning: 'ko' }} onLanguagesChange={() => {}} />);
  return { addAnkiNotesBulk };
}

beforeEach(() => {
  jest.clearAllMocks();
  ankiApi.fieldValuesInDeck.mockResolvedValue({ values: [] });
  ankiApi.generateCardText.mockImplementation(async (text) => ({
    front_text: text,
    back_text: `ko:${text}`,
    spoken_reading: '',
    audio: { filename: 'a.wav', reference: '<audio src="a.wav"></audio>' },
    cueAudio: { filename: 'c.wav', reference: '<audio src="c.wav"></audio>' },
  }));
});

describe('the one rule (deckDupes.js)', () => {
  test('reads both sides of the deck, so a known-language line counts too', async () => {
    deckWithStationCard();
    const keys = await existingLineKeys('deck1', 7, { cue: CUE, target: TARGET });

    expect(ankiApi.fieldValuesInDeck.mock.calls.map(([, , field]) => field).sort()).toEqual([CUE, TARGET]);
    expect(isAlreadyInDeck(keys, 'Where is the station?')).toBe(true);
    expect(isAlreadyInDeck(keys, '역이 어디예요')).toBe(true);
    expect(isAlreadyInDeck(keys, 'Where is the station? ')).toBe(true);
    // lyricsParse's policy: case is never folded.
    expect(isAlreadyInDeck(keys, 'where is the station?')).toBe(false);
    expect(isAlreadyInDeck(keys, 'Where is the toilet?')).toBe(false);
  });

  test('a note type without one of the two fields only asks for the one it has', async () => {
    await existingLineKeys('deck1', 7, { cue: -1, target: TARGET });
    expect(ankiApi.fieldValuesInDeck.mock.calls.map(([, , field]) => field)).toEqual([TARGET]);
  });
});

describe('one line in the add box', () => {
  // One line takes the same route as many (CardForm hands every submit to
  // BulkRun), so a repeat shows the same "already here" row a paste does.
  test('a line that is already a card on its known-language side makes nothing and says so', async () => {
    deckWithStationCard();
    const { addAnkiNotesBulk } = renderForm();

    await userEvent.type(screen.getByRole('textbox'), 'Where is the station?{Enter}');

    expect(await screen.findByText('already here')).toBeInTheDocument();
    expect(ankiApi.generateCardText).not.toHaveBeenCalled();
    expect(addAnkiNotesBulk).not.toHaveBeenCalled();
  });

  test('a line on its learning-language side counts too', async () => {
    deckWithStationCard();
    const { addAnkiNotesBulk } = renderForm();

    await userEvent.type(screen.getByRole('textbox'), '역이 어디예요?{Enter}');

    expect(await screen.findByText('already here')).toBeInTheDocument();
    expect(ankiApi.generateCardText).not.toHaveBeenCalled();
    expect(addAnkiNotesBulk).not.toHaveBeenCalled();
  });

  test('a new line is made as before', async () => {
    deckWithStationCard();
    const { addAnkiNotesBulk } = renderForm();

    await userEvent.type(screen.getByRole('textbox'), 'Where is the toilet?{Enter}');

    await waitFor(() => expect(addAnkiNotesBulk.mock.calls.flatMap(([, notes]) => notes)).toHaveLength(1));
    expect(ankiApi.generateCardText.mock.calls[0][0]).toBe('Where is the toilet?');
    expect(screen.queryByText('already here')).not.toBeInTheDocument();
  });
});

describe('a paste', () => {
  test('skips a line the deck has as a known-language side, and makes a line repeated in the paste once', async () => {
    deckWithStationCard();
    const { addAnkiNotesBulk } = renderForm();

    await userEvent.type(
      screen.getByRole('textbox'),
      'Where is the station?{Shift>}{Enter}{/Shift}Where is the toilet?{Shift>}{Enter}{/Shift}Where is the toilet?',
    );
    await userEvent.click(screen.getByRole('button', { name: /Make 2 cards/ }));

    await waitFor(() => expect(screen.getByText(/Done: 1 added/)).toBeInTheDocument());
    expect(screen.getByText(/1 already in the deck/)).toBeInTheDocument();
    expect(ankiApi.generateCardText.mock.calls.map(([text]) => text)).toEqual(['Where is the toilet?']);
    expect(addAnkiNotesBulk.mock.calls.flatMap(([, notes]) => notes)).toHaveLength(1);
  });
});
