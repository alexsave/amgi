import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import CardForm from '../../components/Card/CardForm';
import { useDecks } from '../../contexts/DeckContext';

jest.mock('../../contexts/DeckContext');
// BulkRun has its own tests; here it only has to be handed the lines.
jest.mock('../../components/Card/BulkRun', () => ({ __esModule: true, default: ({ lines }) => (
  <div data-testid="bulk-run">{JSON.stringify(lines)}</div>
) }));

const notetype = { id: 1, name: 'amgi Listening', fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'] };
const languages = { known: 'en', learning: 'ja' };

const renderForm = () => {
  useDecks.mockReturnValue({
    ankiNotetypes: [notetype],
    ensureAnkiNotetypes: jest.fn(),
    ankiStatus: { mode: 'direct' },
  });
  render(<CardForm deckId="d1" languages={languages} onLanguagesChange={jest.fn()} />);
};

describe('CardForm', () => {
  test('a single line shows the same status run as many lines', () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText(/one line per card/i), { target: { value: 'Where is the station?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make the card' }));
    expect(screen.getByTestId('bulk-run').textContent).toBe(JSON.stringify(['Where is the station?']));
  });

  test('several lines are handed over together', () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText(/one line per card/i), { target: { value: 'one\ntwo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make 2 cards' }));
    expect(screen.getByTestId('bulk-run').textContent).toBe(JSON.stringify(['one', 'two']));
  });
});
