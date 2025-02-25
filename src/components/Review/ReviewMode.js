import React, { useState, useEffect } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { useNavigate } from 'react-router-dom';
import RecordingControls from './RecordingControls';
import CardPreview from './CardPreview';
import EvaluationResult from './EvaluationResult';
import VoiceMode from './VoiceMode';
import { useAudio } from '../../hooks/useAudio';
import { useReview } from '../../contexts/ReviewContext';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import { LanguageIcon, MicrophoneIcon } from '@heroicons/react/24/solid';
import './ReviewMode.css';

const ReviewMode = () => {
  const { decks, currentDeckId } = useDecks();
  const navigate = useNavigate();
  const audio = useAudio();
  const review = useReview();
  const { currentCardId, cardsById, attempts, showAnswer, evaluationResult, newCardsCount, reviewCardsCount, learningCardsCount } = review;
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  
  const currentCard = currentCardId ? cardsById[currentCardId] : null;

  // Load audio when current card changes
  useEffect(() => {
    if (currentCard) {
      // Load front audio
      if (currentCard.front_audio_path) {
        audio.loadAudio(currentCard.front_audio_path)
      }

      // Load back audio
      if (currentCard.back_audio_path) {
        audio.loadAudio(currentCard.back_audio_path)
      }
    }
  }, [currentCardId]);

  const handleEvaluationResult = (data) => {

    if (!data || !currentCard) {
      return;
    }

    review.setEvaluationResult(data);
    
    // Simplified quality system - only correct/incorrect
    const quality = data.result === 'correct' ? 'correct' : 'incorrect';

    // Update card scheduling
    review.updateCardSchedulingServer(currentCardId, quality);
    
    // Play evaluation audio if available
    if (data.audio) {
      const audioData = new Uint8Array(data.audio);
      const blob = new Blob([audioData], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audio.evaluationAudioRef.current.src = url;
      audio.evaluationAudioRef.current.play()
      
      // Clean up the URL when audio ends
      audio.evaluationAudioRef.current.onended = () => {
        URL.revokeObjectURL(url);
      };
    }
    
    if (data.result === 'quit') {
      review.setShowAnswer(true);
      setTimeout(review.moveToNextCard, 500); // Quick skip for quit commands
    } else if (data.result === 'correct') {
      setTimeout(review.moveToNextCard, 2000); // 2 second delay for correct answers
    } else {
      // Incorrect answer
      review.setAttempts(prev => {
        const newAttempts = prev + 1;
        if (newAttempts >= 3) {
          review.setShowAnswer(true);
          setTimeout(review.moveToNextCard, 2000);
        }
        return newAttempts;
      });
    }
  };

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: handleEvaluationResult
  });

  const handleBackToList = () => {
    navigate('/decks');
  };

  if (!currentCardId) {
    return (
      <div className="review-complete">
        <h3>🎉 Review Complete!</h3>
        <p>You've reviewed all due cards in this deck.</p>
        <button onClick={handleBackToList} className="back-btn">
          Back to Decks
        </button>
      </div>
    );
  }

  return (
    <div className="review-mode">
      <div className="mode-header">
        <button onClick={handleBackToList} className="back-btn">
          ← Back to Decks
        </button>
        <h2>Reviewing: {decks[currentDeckId].name}</h2>
        <div className="voice-mode-switch-container">
          <div 
            onClick={() => setIsVoiceMode(!isVoiceMode)} 
            className={`voice-mode-switch ${isVoiceMode ? 'active' : ''}`}
          >
            <div className="switch-icons">
              <LanguageIcon className="icon text-icon" />
              <MicrophoneIcon className="icon mic-icon" />
            </div>
            <div className="switch-handle"></div>
          </div>
        </div>
      </div>

      <div className="card-progress">
        {`New Cards: ${newCardsCount} • Review Cards: ${reviewCardsCount} • Learning Cards: ${learningCardsCount}`}
      </div>

      {isVoiceMode ? (
        <VoiceMode />
      ) : (
        <>
          <CardPreview
            currentCard={currentCard}
            showAnswer={showAnswer}
            audio={audio}
          />

          <div className="review-controls">
            <div className="attempts-counter">
              Attempts: {attempts}/3
            </div>

            <RecordingControls
              isRecording={audio.isRecording}
              isLoading={audio.isLoading}
              onStartRecording={audio.startRecording}
              onStopRecording={async () => {
                const audioBlob = await audio.stopRecording();
                if (!audioBlob) return;
                await evaluateSpeech(audioBlob, currentCard);
              }}
            />

            <EvaluationResult result={evaluationResult} />
          </div>
        </>
      )}

    </div>
  );
};

export default ReviewMode; 