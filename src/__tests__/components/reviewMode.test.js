import React from 'react';
import { render, screen } from '@testing-library/react';
import ReviewMode from '../../components/Review/ReviewMode';
import { useDecks } from '../../contexts/DeckContext';
import { useAudio } from '../../contexts/useAudio';
import { useReview } from '../../contexts/ReviewContext';

jest.mock('../../contexts/DeckContext');
// A factory, not the automock: the real module pulls in vmsg, which is ESM.
jest.mock('../../contexts/useAudio', () => ({ useAudio: jest.fn() }));
jest.mock('../../contexts/ReviewContext');
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('../../hooks/useSpeechEvaluation', () => ({
  useSpeechEvaluation: () => ({ evaluateSpeech: jest.fn() })
}));
// Draws to a canvas, which jsdom does not have.
jest.mock('../../components/Review/RadialAudioVisualizer', () => () => null);

const card = (overrides = {}) => ({
  id: 'card1',
  front_text: 'Hello',
  back_text: '안녕하세요',
  front_audio_path: 'front.mp3',
  back_audio_path: 'back.mp3',
  ...overrides
});

const setup = ({ currentCard = card(), saveState } = {}) => {
  useDecks.mockReturnValue({ decks: { deck1: { id: 'deck1', name: 'Deck 1' } }, currentDeckId: 'deck1' });
  useAudio.mockReturnValue({
    isRecording: false,
    playAudio: jest.fn().mockResolvedValue(undefined),
    playAudioToEnd: jest.fn().mockResolvedValue(undefined),
    startRecording: jest.fn().mockResolvedValue(undefined),
    stopRecording: jest.fn().mockResolvedValue(null),
    ensureAudioContext: jest.fn().mockResolvedValue(undefined),
    audioContextRef: { current: null },
    recordingStreamRef: { current: null }
  });
  useReview.mockReturnValue({
    currentCard,
    currentCardId: currentCard?.id ?? null,
    newCardsCount: 1,
    learningCardsCount: 0,
    reviewCardsCount: 0,
    markCorrectGetNext: jest.fn(),
    markAgainGetNext: jest.fn(),
    syncCardsToDeck: jest.fn(),
    saveState: saveState || { pending: 0, failed: 0, lastError: null },
    retryFailedSaves: jest.fn()
  });
  return render(<ReviewMode />);
};

describe('the review screen', () => {
  describe('a card with no audio', () => {
    test('shows the prompt text instead of leaving a silent blank card', () => {
      setup({ currentCard: card({ front_audio_path: null }) });

      // Normally the front is hidden until the answer, because it is heard.
      // With nothing to hear, hiding it leaves the learner nothing at all.
      expect(document.querySelector('.flashcard-text.front').className).not.toContain('is-hidden');
    });

    test('keeps the prompt hidden when there is audio to play', () => {
      setup();

      expect(document.querySelector('.flashcard-text.front').className).toContain('is-hidden');
    });
  });

  describe('unsaved answers', () => {
    test('says so, and offers a retry', () => {
      setup({ saveState: { pending: 0, failed: 2, lastError: new Error('offline') } });

      expect(screen.getByText('2 answers could not be saved.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    test('says nothing at all while saves are landing', () => {
      setup({ saveState: { pending: 1, failed: 0, lastError: null } });

      expect(document.querySelector('.review-save-warning')).toBeNull();
    });

    test('reports a save that is still being retried', () => {
      setup({ saveState: { pending: 1, failed: 0, lastError: new Error('offline') } });

      expect(screen.getByText(/still retrying your answers/)).toBeInTheDocument();
    });
  });
});
