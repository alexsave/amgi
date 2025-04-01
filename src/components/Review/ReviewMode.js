import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { MicrophoneIcon, PlayIcon, ChevronDoubleRightIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { useNavigate } from 'react-router-dom';
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
  const { currentCard, currentCardId, attempts, newCardsCount, reviewCardsCount, learningCardsCount } = review;
  const [evaluationResult, setEvaluationResult] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [transitionTimeLeft, setTransitionTimeLeft] = useState(0);
  const transitionTimerRef = useRef(null);
  const [transitionCard, setTransitionCard] = useState(null);
  const [isPlayingLocked, setIsPlayingLocked] = useState(false); // Lock to prevent rapid clicks
  const [lastClickedAudio, setLastClickedAudio] = useState(null); // 'front', 'hint', or null
  const [hasTransitionCanceled, setHasTransitionCanceled] = useState(false); // Track if transition was canceled

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
        // Clear evaluation result when starting recording
        setEvaluationResult(null);
        
        // Start recording
        await audio.startRecording();

      }
    } catch (error) {
      console.error("Error with recording:", error);
      setIsEvaluating(false);
      audio.setError(error.message);
      
      // Display error as evaluation result for consistent UI
      setEvaluationResult({
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

    setEvaluationResult(data);

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
      setTransitionTimeLeft(100);
      
      // Use a self-adjusting countdown implementation with one final callback
      // instead of an interval with nested callbacks
      const startTime = Date.now();
      const duration = 100000; // 10 seconds in milliseconds
      
      const updateCountdown = () => {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
        
        setTransitionTimeLeft(remaining);
        
        if (remaining <= 0) {
          // Time's up! Move to next card
          console.log(`[DEBUG] Timer completed. Moving to next card from ID: ${currentCardId}`);
          setEvaluationResult(null);
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
      
      // Check if this is the third incorrect attempt - if so, show the transition state
      if (attempts >= 2) {
        // Set up transition state similar to correct answers
        const cardToTransition = { ...currentCard };
        setTransitionCard(cardToTransition);
        setIsTransitioning(true);
        setTransitionTimeLeft(100);
        
        const startTime = Date.now();
        const duration = 100000; // 10 seconds
        
        const updateCountdown = () => {
          const elapsed = Date.now() - startTime;
          const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
          
          setTransitionTimeLeft(remaining);
          
          if (remaining <= 0) {
            console.log(`[DEBUG] Timer completed after incorrect attempts. Moving to next card from ID: ${currentCardId}`);
            setEvaluationResult(null);
            review.markIncorrectGetNext();
            setIsTransitioning(false);
            return;
          }
          
          transitionTimerRef.current = setTimeout(updateCountdown, 200);
        };
        
        transitionTimerRef.current = setTimeout(updateCountdown, 200);
      } else {
        // For attempts < 3, proceed immediately
        review.markIncorrectGetNext();
      }
    }
  }, [currentCard, review, audio, attempts]);

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
    setEvaluationResult(null);
    setHasTransitionCanceled(false);
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

  // Add these new handler functions
  const handleSkipTransition = () => {
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    
    console.log("Skipping transition, moving to next card");
    setEvaluationResult(null);
    
    // Determine if this was a correct or incorrect transition
    if (evaluationResult && evaluationResult.result === 'correct') {
      review.markCorrectGetNext();
    } else {
      review.markIncorrectGetNext();
    }
    
    setIsTransitioning(false);
  };
  
  const handleCancelTransition = () => {
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    
    console.log("Canceling transition, staying on current card");
    setIsTransitioning(false);
    setHasTransitionCanceled(true); // Set this flag when transition is canceled
  };

  // Add a new handler for the Next button
  const handleNextCard = () => {
    console.log("Moving to next card after canceled transition");
    setEvaluationResult(null);
    setHasTransitionCanceled(false);
    
    // Determine if this was a correct or incorrect transition based on the last evaluation
    if (evaluationResult && evaluationResult.result === 'correct') {
      review.markCorrectGetNext();
    } else {
      review.markIncorrectGetNext();
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

      <div className="review-controls" style={{ height: '100px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        {isEvaluating ? (
          <div className="evaluation-loading">Evaluating your speech...</div>
        ) : evaluationResult ? (
          <div className={`evaluation-result ${evaluationResult.result}`}>
            <p>{evaluationResult.message}</p>
          </div>
        ) : (
          <div className="remaining-cards">
            {`New: ${newCardsCount} • Review: ${reviewCardsCount} • Learning: ${learningCardsCount}`}
          </div>
        )}
      </div>

      {/* New flashcard layout with dashed line in the middle */}
      <div className="flashcard-container">
        <div className="flashcard-top">
          {(attempts >= 2 || isTransitioning || hasTransitionCanceled) && (
            <div className="flashcard-text front">
              {transitionCard && isTransitioning ? transitionCard.front_text : currentCard.front_text}
            </div>
          )}
        </div>
        <div className="flashcard-bottom">
          {(attempts >= 3 || isTransitioning || hasTransitionCanceled) && (
            <div className="flashcard-text back">
              {transitionCard && isTransitioning ? transitionCard.back_text : currentCard.back_text}
            </div>
          )}
        </div>
      {isTransitioning && (
        <div className="transition-timer-container">
          <div className="transition-timer">
            <span>Next card in {transitionTimeLeft} {transitionTimeLeft === 1 ? 'second' : 'seconds'}</span>
            <div className="transition-controls">
              <button className="transition-button " onClick={handleSkipTransition} title="Skip to next card">
                <ChevronDoubleRightIcon className="button-icon" />
              </button>
              <button className="transition-button" onClick={handleCancelTransition} title="Stay on current card">
                <XMarkIcon className="button-icon" />
              </button>
            </div>
          </div>
        </div>
      )}
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
              <PlayIcon className="button-icon-controls" />
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
                  <PlayIcon className="button-icon-controls" />
                </div>
              </button>
              <div className="button-label">Hint Audio</div>
            </>
          )}
          
          {/* Show hint audio during transition */}
          {isTransitioning && currentCard.back_audio_path && (
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
                  <PlayIcon className="button-icon-controls" />
                </div>
              </button>
              <div className="button-label">Hint Audio</div>
            </>
          )}
        </div>

        <div className="button-container right-button">
          <div className="mic-visualizer-container">
            <RadialAudioVisualizer
              visualizerType="user"
              isActive={audio.isRecording}
              key={`user-visualizer-${audio.isRecording}`}
            />
          </div>
          {hasTransitionCanceled ? (
            <button
              className="hint-button"
              onClick={handleNextCard}
            >
              <div className="button-inner">
                <ChevronDoubleRightIcon className="button-icon-controls" />
              </div>
            </button>
          ) : (
            <button
              className={`hint-button ${audio.isRecording ? 'recording' : ''}`}
              onClick={handleRecordButtonClick}
              disabled={attempts >= 3 || audio.isLoading || isEvaluating || isTransitioning || !currentCard}
            >
              <div className="button-inner">
                <MicrophoneIcon className="button-icon-controls" />
              </div>
              {isEvaluating && <div className="loading-spinner"></div>}
            </button>
          )}
          <div className="button-label">
            {hasTransitionCanceled ? "Next Card" : "Record Answer"}
          </div>
        </div>
      </div>


    </div>
  );
};

export default ReviewMode; 