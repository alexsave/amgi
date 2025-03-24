import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { MicrophoneIcon, PlayIcon } from '@heroicons/react/24/solid';
import { useNavigate } from 'react-router-dom';
import EvaluationResult from './EvaluationResult';
import { useAudio } from '../../contexts/useAudio';
import { useReview } from '../../contexts/ReviewContext';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import RadialAudioVisualizer from './RadialAudioVisualizer';
import './ReviewMode.css';

const ReviewMode = () => {
  const { decks, currentDeckId } = useDecks();
  const navigate = useNavigate();
  const audio = useAudio();
  const review = useReview();
  const { currentCard, currentCardId, attempts, showAnswer, evaluationResult, newCardsCount, reviewCardsCount, learningCardsCount } = review;
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [transitionTimeLeft, setTransitionTimeLeft] = useState(0);
  const transitionTimerRef = useRef(null);
  const [transitionCard, setTransitionCard] = useState(null);
  const [showCardContent, setShowCardContent] = useState(false);
  const [isPlayingLocked, setIsPlayingLocked] = useState(false); // Lock to prevent rapid clicks

  // Only retaining the volume scale for the UI, all other audio state moved to contexts
  const [audioScale, setAudioScale] = useState(0);

  // Load audio when current card changes
  useEffect(() => {
    if (currentCard) {
      console.log("Current card updated:", {
        id: currentCard.id,
        front_text: currentCard.front_text, 
        back_text: currentCard.back_text,
        front_lang: currentCard.front_lang,
        back_lang: currentCard.back_lang
      });

      // Preload front audio
      if (currentCard.front_audio_path) {
        audio.loadAudio(currentCard.front_audio_path).catch(err => {
          console.error('Error preloading front audio:', err);
        });
      }

      // Preload back audio
      if (currentCard.back_audio_path) {
        audio.loadAudio(currentCard.back_audio_path).catch(err => {
          console.error('Error preloading back audio:', err);
        });
      }
    }
  }, [currentCardId, audio]);

  // Handle recording state changes
  useEffect(() => {
    if (!audio.isRecording) {
      // When recording stops
      setIsEvaluating(false);
    }
  }, [audio.isRecording]);

  // Play button click handler (simplified)
  const handlePlayButtonClick = async (audioPath) => {
    // Prevent rapid clicks
    if (isPlayingLocked || audio.isLoading) {
      console.log('Ignoring play request - playback locked or loading');
      return;
    }
    
    setIsPlayingLocked(true);
    
    try {
      await audio.ensureAudioContext();
      await audio.playAudio(audioPath);
    } catch (error) {
      console.error("Error playing audio:", error);
    } finally {
      // Add small delay to prevent immediate re-click
      setTimeout(() => {
        setIsPlayingLocked(false);
      }, 300);
    }
  };

  // Record button click handler (simplified)
  const handleRecordButtonClick = async () => {
    try {
      await audio.ensureAudioContext();
      if (audio.isRecording) {
        const audioBlob = await audio.stopRecording();
        if (!audioBlob) return;
        setIsEvaluating(true);
        
        if (!currentCard) {
          setIsEvaluating(false);
          console.error("Current card is not available for evaluation");
          return;
        }
        
        await evaluateSpeech(audioBlob, currentCard);
        setIsEvaluating(false);
      } else {
        // Start recording
        setAudioScale(0); // Reset the audio scale
        await audio.startRecording();
        
        // Force a small delay to ensure the visualizer detects the stream
        setTimeout(() => {
          // This will trigger a re-render and help the visualizer detect the stream change
          setAudioScale(1);
        }, 100);
      }
    } catch (error) {
      console.error("Error with recording:", error);
      setIsEvaluating(false);
    }
  };

  const handleEvaluationResult = useCallback((data) => {
    if (!data || !currentCard) {
      console.error("Invalid evaluation result or missing current card");
      return;
    }

    console.log("Received evaluation result:", data);
    
    review.setEvaluationResult(data);

    // Simplified quality system - only correct/incorrect
    const quality = data.result === 'correct' ? 'correct' : 'incorrect';

    // Update card scheduling based on result
    if (data.result === 'correct') {
      const cardToTransition = {...currentCard};
      setTransitionCard(cardToTransition);
      setIsTransitioning(true);
      review.setShowAnswer(true);
      
      // Set initial countdown value (3 seconds)
      setTransitionTimeLeft(3);
      
      // Clear any existing timer
      if (transitionTimerRef.current) {
        clearInterval(transitionTimerRef.current);
      }
      
      // Start countdown timer
      transitionTimerRef.current = setInterval(() => {
        setTransitionTimeLeft(prev => {
          if (prev <= 1) {
            // When timer reaches 0, clear interval and move to next card
            clearInterval(transitionTimerRef.current);
            
            // Use setTimeout to ensure state updates happen outside render cycle
            setTimeout(() => {
              review.setEvaluationResult(null);
              review.markCorrectGetNext();
              setIsTransitioning(false);
            }, 0);
            
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else if (data.result === 'incorrect') {
      // Use setTimeout to move state updates outside render cycle
      setTimeout(() => {
        review.markIncorrectGetNext();
      }, 0);
    }

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
      setTransitionTimeLeft(1);
      
      // Clear any existing timer
      if (transitionTimerRef.current) {
        clearInterval(transitionTimerRef.current);
      }
      
      setTimeout(() => {
        review.setEvaluationResult(null);
        review.moveToNextCard();
      }, 500); // Quick skip for quit commands
    } else if (data.result === 'incorrect') {
      // Incorrect answer
      review.setAttempts(prev => {
        const newAttempts = prev + 1;
        if (newAttempts >= 3) {
          review.setShowAnswer(true);
          
          // Clear any existing timer
          if (transitionTimerRef.current) {
            clearInterval(transitionTimerRef.current);
          }
          
          setTimeout(() => {
            review.setEvaluationResult(null);
            review.moveToNextCard();
          }, 2000);
        }
        return newAttempts;
      });
    }
  }, [currentCard, review]);

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: handleEvaluationResult
  });

  // Store current card in state when transitioning to prevent reference issues
  useEffect(() => {
    if (isTransitioning && currentCard && !transitionCard) {
      setTransitionCard({...currentCard});
    } else if (!isTransitioning) {
      setTransitionCard(null);
    }
  }, [isTransitioning, currentCard, transitionCard]);

  const handleBackToList = () => {
    navigate('/decks');
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearInterval(transitionTimerRef.current);
      }
    };
  }, []);

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
    <div className="review-mode" style={{ display: 'flex', flex: 1, height: '100%', flexDirection: 'column', alignItems: 'center' }}>
      <div className="mode-header">
        <button onClick={handleBackToList} className="back-btn">
          ← Back to Decks
        </button>
        <h2>Reviewing: {decks[currentDeckId].name}</h2>
        <div className="card-toggle-container">
          <button 
            className={`card-toggle-button ${showCardContent ? 'active' : ''}`}
            onClick={() => setShowCardContent(!showCardContent)}
          >
            {showCardContent ? 'Hide Card' : 'Show Card'}
          </button>
        </div>
      </div>

      <div className="card-progress">
        {`New Cards: ${newCardsCount} • Review Cards: ${reviewCardsCount} • Learning Cards: ${learningCardsCount}`}
      </div>

      <div className="review-controls">
        <div className="attempts-counter">
          Attempts: {attempts}/3
        </div>

        {isEvaluating ? (
          <div className="evaluation-loading">Evaluating your speech...</div>
        ) : (
          <EvaluationResult result={evaluationResult} />
        )}
      </div>

      <div className="audio-controls-container">
        <div className="audio-control-column">
          <div className="audio-button-container">
            <div className="visualizer-container">
              <RadialAudioVisualizer
                visualizerType="ai"
              />
            </div>
            <button
              className={`audio-button play-button ${audio.isPlayingAudio ? 'playing' : ''} ${isPlayingLocked ? 'loading' : ''}`}
              onClick={() => handlePlayButtonClick(currentCard.front_audio_path)}
              disabled={audio.isPlayingAudio || isPlayingLocked}
            >
              <div className="button-inner">
                <PlayIcon className="button-icon" />
              </div>
            </button>
            {(isTransitioning || showCardContent) && (transitionCard || currentCard) && (
              <div className="text-content">{transitionCard ? transitionCard.front_text : currentCard.front_text}</div>
            )}
          </div>
        </div>

        <div className="audio-control-column">
          <div className="audio-button-container">
            <div className="visualizer-container">
              <RadialAudioVisualizer
                visualizerType="user"
                onVolumeChange={setAudioScale}
                key={`user-visualizer-${audio.isRecording}`} // Force re-mount when recording state changes
              />
            </div>
            <button
              className={`audio-button mic-button ${audio.isRecording ? 'recording' : ''} ${audio.isLoading || isEvaluating ? 'loading' : ''}`}
              onClick={handleRecordButtonClick}
              disabled={showAnswer || audio.isLoading || isEvaluating}
            >
              <div className="button-inner">
                <MicrophoneIcon className="button-icon" />
              </div>
              {isEvaluating && <div className="loading-spinner"></div>}
            </button>
            {(isTransitioning || (showCardContent && showAnswer)) && (transitionCard || currentCard) && (
              <div className="text-content">{transitionCard ? transitionCard.back_text : currentCard.back_text}</div>
            )}
          </div>
        </div>
      </div>
      
      {isTransitioning && (
        <div className="transition-timer-container">
          <div className="transition-timer">
            Next card in {transitionTimeLeft} {transitionTimeLeft === 1 ? 'second' : 'seconds'}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReviewMode; 