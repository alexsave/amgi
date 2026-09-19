import React from 'react';
import { render, screen } from '@testing-library/react';
import CardModal from '../../components/Card/CardModal';
import { useDecks } from '../../contexts/DeckContext';
import { useCardGenerationContext } from '../../contexts/CardGenerationContext';

jest.mock('../../contexts/DeckContext');
// A factory, not the automock: the real module pulls in vmsg, which is ESM.
jest.mock('../../contexts/useAudio', () => ({ useAudio: () => ({ playAudio: jest.fn() }) }));
jest.mock('../../contexts/CardGenerationContext', () => ({ useCardGenerationContext: jest.fn() }));
jest.mock('next/navigation', () => ({ useParams: () => ({ id: 'deck1' }) }));

beforeEach(() => {
  useDecks.mockReturnValue({
    decks: { deck1: { id: 'deck1', known_language: 'en', learning_language: 'ko' } },
    addCardToDeck: jest.fn()
  });
  useCardGenerationContext.mockReturnValue({
    generatedCard: { front_text: 'Hello', back_text: '안녕하세요', front_audio_path: 'f.mp3', back_audio_path: 'b.mp3' },
    clearInput: jest.fn(),
    setEditableText: jest.fn(),
    updateCardText: jest.fn(),
    regenerateCardPart: jest.fn(),
    isGenerating: false,
    regeneratingParts: []
  });
});

describe('the generated-card modal', () => {
  test('every control in it does something', () => {
    render(<CardModal isOpen onClose={jest.fn()} />);

    // A button with no handler looks live and is not: the microphone
    // "Record your own audio" control was one, and the browser has no way to
    // write to the audio bucket anyway.
    const inert = Array.from(document.querySelectorAll('.card-modal-content button')).filter(
      (button) => !button.onclick
    );
    expect(inert).toEqual([]);
  });

  test('offers no recording control it cannot honour', () => {
    render(<CardModal isOpen onClose={jest.fn()} />);

    expect(screen.queryByTitle('Record your own audio')).toBeNull();
  });
});
