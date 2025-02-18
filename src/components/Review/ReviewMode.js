import React, { useState, useEffect } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { useNavigate } from 'react-router-dom';
import RecordingControls from './RecordingControls';
import Timeline from './Timeline';
import CardPreview from './CardPreview';
import EvaluationResult from './EvaluationResult';
import VoiceMode from './VoiceMode';
import { useAudio } from '../../hooks/useAudio';
import { useReview } from '../../hooks/useReview';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import { LanguageIcon, MicrophoneIcon } from '@heroicons/react/24/solid';
import './ReviewMode.css';

const ReviewMode = () => {
  const { currentDeck, decks, dueCards, updateCard, mode, currentDeckId } = useDecks();
  const { currentCard, initReview } = useReview();
  const navigate = useNavigate();
  const audio = useAudio();
  const review = useReview();
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [voiceChatResponse, setVoiceChatResponse] = useState(null);
  
  //const currentCard = review.dueCards[review.currentCardIndex];

  // Load audio when current card changes
  useEffect(() => {
    if (currentCard) {
      console.log('ReviewMode: Loading audio for current card:', JSON.stringify(currentCard));
      // Load front audio
      if (currentCard.front_audio_path) {
        audio.loadAudio(currentCard.front_audio_path)
          .catch(err => console.error('Error loading front audio:', err));
      }

      // Load back audio
      if (currentCard.back_audio_path) {
        audio.loadAudio(currentCard.back_audio_path)
          .catch(err => console.error('Error loading back audio:', err));
      }
    }
  }, [currentCard]);

  const handleEvaluationResult = (data) => {
    console.log('ReviewMode: Received evaluation result:', {
      result: data?.result,
      messageLength: data?.message?.length,
      hasAudio: !!data?.audio,
      fullData: data
    });

    if (!data) {
      console.error('ReviewMode: No evaluation data received');
      return;
    }

    review.setEvaluationResult(data);
    console.log('ReviewMode: Set evaluation result in review context');
    
    // Simplified quality system - only correct/incorrect
    const quality = data.result === 'correct' ? 'correct' : 'incorrect';
    console.log('ReviewMode: Determined quality:', quality);

    // Update card scheduling
    review.updateCardScheduling(currentCard.created, quality);
    console.log('ReviewMode: Updated card scheduling');
    
    // Play evaluation audio if available
    if (data.audio) {
      console.log('ReviewMode: Playing evaluation audio');
      const audioData = new Uint8Array(data.audio);
      const blob = new Blob([audioData], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audio.evaluationAudioRef.current.src = url;
      audio.evaluationAudioRef.current.play()
        .then(() => console.log('ReviewMode: Started playing evaluation audio'))
        .catch(err => console.error('ReviewMode: Error playing evaluation audio:', err));
      
      // Clean up the URL when audio ends
      audio.evaluationAudioRef.current.onended = () => {
        console.log('ReviewMode: Evaluation audio finished, cleaning up URL');
        URL.revokeObjectURL(url);
      };
    }
    
    if (data.result === 'quit') {
      console.log('ReviewMode: Quit command received, moving to next card quickly');
      review.setShowAnswer(true);
      setTimeout(review.moveToNextCard, 500); // Quick skip for quit commands
    } else if (data.result === 'correct') {
      console.log('ReviewMode: Correct answer, moving to next card after delay');
      setTimeout(review.moveToNextCard, 2000); // 2 second delay for correct answers
    } else {
      console.log('ReviewMode: Incorrect answer, updating attempts');
      // Incorrect answer
      review.setAttempts(prev => {
        const newAttempts = prev + 1;
        console.log('ReviewMode: New attempt count:', newAttempts);
        if (newAttempts >= 3) {
          console.log('ReviewMode: Max attempts reached, showing answer and moving to next card');
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

  if (!currentCard) {
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
        Card {review.currentCardIndex + 1} of ?
      </div>

      {isVoiceMode ? (
        <VoiceMode currentCard={currentCard} />
      ) : (
        <>
          <CardPreview
            currentCard={currentCard}
            showAnswer={review.showAnswer}
            audio={audio}
          />

          <div className="review-controls">
            <div className="attempts-counter">
              Attempts: {review.attempts}/3
            </div>

            <RecordingControls
              isRecording={audio.isRecording}
              isLoading={audio.isLoading}
              onStartRecording={audio.startRecording}
              onStopRecording={async () => {
                console.log('ReviewMode: Stopping recording with current card:', {
                  front_text: currentCard.front_text,
                  back_text: currentCard.back_text,
                  sourceLang: currentCard.sourceLang,
                  targetLang: currentCard.targetLang
                });
                const audioBlob = await audio.stopRecording();
                if (!audioBlob) return;
                console.log('ReviewMode: Got audio blob:', {
                  size: audioBlob.size,
                  type: audioBlob.type
                });
                await evaluateSpeech(audioBlob, currentCard);
              }}
            />

            <EvaluationResult result={review.evaluationResult} />
          </div>
        </>
      )}

      <Timeline
        cards={review.dueCards}
        currentIndex={review.currentCardIndex}
      />
    </div>
  );
};

export default ReviewMode; 