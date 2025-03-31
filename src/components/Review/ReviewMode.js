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
  const { currentCard, currentCardId, attempts, evaluationResult, newCardsCount, reviewCardsCount, learningCardsCount } = review;
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [transitionTimeLeft, setTransitionTimeLeft] = useState(0);
  const transitionTimerRef = useRef(null);
  const [transitionCard, setTransitionCard] = useState(null);
  const [showCardContent, setShowCardContent] = useState(false);
  const [isPlayingLocked, setIsPlayingLocked] = useState(false); // Lock to prevent rapid clicks
  const [lastClickedAudio, setLastClickedAudio] = useState(null); // 'front', 'hint', or null

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

        // Ensure current card has language fields before evaluation
        if (!currentCard.front_lang || !currentCard.back_lang) {
          // Get deck languages from context
          const deck = decks[currentDeckId];
          if (deck) {
            // Add language fields if missing
            if (!currentCard.front_lang) currentCard.front_lang = deck.known_language || 'en';
            if (!currentCard.back_lang) currentCard.back_lang = deck.learning_language || 'en';
            console.log("Added missing language fields to card:", {
              front_lang: currentCard.front_lang,
              back_lang: currentCard.back_lang
            });
          }
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
      audio.setError(error.message);
      
      // Display error as evaluation result for consistent UI
      review.setEvaluationResult({
        result: 'error',
        message: error.message,
        audio: null
      });
    }
  };

  const handleEvaluationResult = useCallback((data) => {
    if (!data || !currentCard) {
      console.error("Invalid evaluation result or missing current card");
      return;
    }

    console.log("Received evaluation result:", data);

    // Store card ID for later reference
    const currentCardId = currentCard.id;
    console.log(`[DEBUG] Processing evaluation for card ID: ${currentCardId}`);

    review.setEvaluationResult(data);

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

    // Handle different result types
    if (data.result === 'correct') {
      // Clear any existing timer before setting up a new one
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      
      const cardToTransition = { ...currentCard };
      setTransitionCard(cardToTransition);
      setIsTransitioning(true);
      
      // Initial countdown value
      setTransitionTimeLeft(10);
      
      // Use a self-adjusting countdown implementation with one final callback
      // instead of an interval with nested callbacks
      const startTime = Date.now();
      const duration = 10000; // 10 seconds in milliseconds
      
      const updateCountdown = () => {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
        
        setTransitionTimeLeft(remaining);
        
        if (remaining <= 0) {
          // Time's up! Move to next card
          console.log(`[DEBUG] Timer completed. Moving to next card from ID: ${currentCardId}`);
          review.setEvaluationResult(null);
          review.markCorrectGetNext();
          setIsTransitioning(false);
          return;
        }
        
        // Continue updating until we reach zero
        transitionTimerRef.current = setTimeout(updateCountdown, 200);
      };
      
      // Start the countdown
      transitionTimerRef.current = setTimeout(updateCountdown, 200);
      
    } else if (data.result === 'incorrect') {
      // Process incorrect answer immediately
      console.log(`[DEBUG] Processing incorrect answer for card ID: ${currentCardId}`);
      review.markIncorrectGetNext();
    }
  }, [currentCard, review, audio]);

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: handleEvaluationResult
  });

  // Store current card in state when transitioning to prevent reference issues
  useEffect(() => {
    if (isTransitioning && currentCard && !transitionCard) {
      setTransitionCard({ ...currentCard });
    } else if (!isTransitioning) {
      setTransitionCard(null);
    }
  }, [isTransitioning, currentCard, transitionCard]);

  const handleBackToList = () => {
    // Sync the updated card states from review context back to deck context
    review.syncCardsToDeck();
    
    navigate('/decks');
  };

  // Just clean up the timer when unmounting, no need to sync
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
    };
  }, []);

  // When the card changes, reset the lastClickedAudio
  useEffect(() => {
    setLastClickedAudio(null);
  }, [currentCardId]);

  const handlePlayFrontAudio = () => {
    if (currentCard?.front_audio_path) {
      setLastClickedAudio('front');
      handlePlayButtonClick(currentCard.front_audio_path);
    }
  };

  const handlePlayHintAudio = () => {
    if (currentCard?.back_audio_path) {
      setLastClickedAudio('hint');
      handlePlayButtonClick(currentCard.back_audio_path);
    }
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
    <div className="review-mode" style={{ display: 'flex', flex: 1, height: '100%', flexDirection: 'column', alignItems: 'center' }}>
      <div className="mode-header">
        <button onClick={handleBackToList} className="back-btn">
          ← Decks
        </button>
        <h2>{decks[currentDeckId].name}</h2>
      </div>

      <div className="card-progress">
        {`New: ${newCardsCount} • Review: ${reviewCardsCount} • Learning: ${learningCardsCount}`}
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

      {/* New flashcard layout with dashed line in the middle */}
      <div className="flashcard-container">
        <div className="flashcard-top">
          {(attempts >= 2 || isTransitioning) && (
            <div className="flashcard-text front">
              {transitionCard ? transitionCard.front_text : currentCard.front_text}
            </div>
          )}
        </div>
        <div className="flashcard-bottom">
          {(attempts >= 3 || isTransitioning) && (
            <div className="flashcard-text back">
              {transitionCard ? transitionCard.back_text : currentCard.back_text}
            </div>
          )}
        </div>
      </div>

      {/* Buttons in a row at the bottom of the screen */}
      <div className="bottom-controls-container">
        {/* Left (Play Front Audio) button */}
        <div className="button-container left-button">
          <div className="front-visualizer-container">
            <RadialAudioVisualizer
              visualizerType="front"
              isActive={lastClickedAudio === 'front'}
            />
          </div>
          <button
            className="hint-button"
            onClick={handlePlayFrontAudio}
            disabled={audio.isPlayingAudio || isPlayingLocked}
          >
            <div className="button-inner">
              <PlayIcon className="button-icon" />
            </div>
          </button>
          <div className="button-label">Play Audio</div>
        </div>

        {/* Center (Hint Audio) button - only visible after first attempt and before showing answer */}
        <div className="button-container center-button">
          {attempts >= 1 && attempts < 3 && !isTransitioning && currentCard.back_audio_path && (
            <>
              <div className="hint-visualizer-container">
                <RadialAudioVisualizer
                  visualizerType="hint"
                  isActive={lastClickedAudio === 'hint'}
                />
              </div>
              <button
                className="hint-button"
                onClick={handlePlayHintAudio}
                disabled={audio.isPlayingAudio || isPlayingLocked}
              >
                <div className="button-inner">
                  <PlayIcon className="button-icon" />
                </div>
              </button>
              <div className="button-label">Hint Audio</div>
            </>
          )}
        </div>

        {/* Right (Microphone) button */}
        <div className="button-container right-button">
          <div className="mic-visualizer-container">
            <RadialAudioVisualizer
              visualizerType="user"
              isActive={audio.isRecording}
              onVolumeChange={setAudioScale}
              key={`user-visualizer-${audio.isRecording}`}
            />
          </div>
          <button
            className={`hint-button ${audio.isRecording ? 'recording' : ''}`}
            onClick={handleRecordButtonClick}
            disabled={attempts >= 3 || audio.isLoading || isEvaluating || isTransitioning || !currentCard}
          >
            <div className="button-inner">
              <MicrophoneIcon className="button-icon" />
            </div>
            {isEvaluating && <div className="loading-spinner"></div>}
          </button>
          <div className="button-label">Record Answer</div>
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