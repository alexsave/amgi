import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { MicrophoneIcon, PlayIcon, ChevronDoubleRightIcon, XMarkIcon, ChatBubbleLeftRightIcon } from '@heroicons/react/24/solid';
import { useNavigate } from 'react-router-dom';
import { useAudio } from '../../contexts/useAudio';
import { useReview } from '../../contexts/ReviewContext';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import RadialAudioVisualizer from './RadialAudioVisualizer';
import { base64ToBlob } from '../../network/utils';
import './ReviewMode.css';

// How long the "next card in N seconds" transition lasts.
const TRANSITION_SECONDS = 10;

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

        // Starter-deck cards get their audio in the background; without the
        // reference audio there's nothing to evaluate against yet.
        if (!currentCard.back_audio_path) {
          setIsEvaluating(false);
          setEvaluationResult({
            result: 'error',
            message: "This card's audio is still being generated — check back in a moment.",
            audio: null
          });
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

    setEvaluationResult(data);

    // Play evaluation audio if available (base64 mp3 from the speech function)
    if (data.audio) {
      const blob = base64ToBlob(data.audio);
      const url = URL.createObjectURL(blob);
      audio.evaluationAudioRef.current.src = url;
      audio.evaluationAudioRef.current.play().catch(err => {
        console.error('Error playing evaluation audio:', err);
      });

      // Clean up the URL when audio ends
      audio.evaluationAudioRef.current.onended = () => {
        URL.revokeObjectURL(url);
      };
    }

    // Shows the answer for TRANSITION_SECONDS, then advances to the next card.
    const startTransition = (advance) => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }

      setTransitionCard({ ...currentCard });
      setIsTransitioning(true);
      setTransitionTimeLeft(TRANSITION_SECONDS);

      const startTime = Date.now();
      const duration = TRANSITION_SECONDS * 1000;

      const updateCountdown = () => {
        const elapsed = Date.now() - startTime;
        const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));

        setTransitionTimeLeft(remaining);

        if (remaining <= 0) {
          setEvaluationResult(null);
          advance();
          setIsTransitioning(false);
          return;
        }

        transitionTimerRef.current = setTimeout(updateCountdown, 200);
      };

      transitionTimerRef.current = setTimeout(updateCountdown, 200);
    };

    if (data.result === 'correct') {
      startTransition(review.markCorrectGetNext);
    } else if (data.result === 'incorrect') {
      // On the final failed attempt, show the answer before moving on;
      // otherwise let the user retry immediately.
      if (attempts >= 2) {
        startTransition(review.markIncorrectGetNext);
      } else {
        review.markIncorrectGetNext();
      }
    }
  }, [currentCard, review, audio, attempts]);

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: handleEvaluationResult
  });

  // The learner is the final judge of their own pronunciation: this reruns
  // the result flow as correct. (The failed attempt already counted, so the
  // scheduler treats it as a hard-won success rather than a clean one.)
  const handleOverrideCorrect = () => {
    handleEvaluationResult({
      result: 'correct',
      message: 'Marked correct — your call.',
      audio: null
    });
  };

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

  // When a card comes up: reset per-card UI state, play its prompt audio
  // right away (this is a listening-first app — the front audio IS the
  // question), and preload the back audio for the hint button. Autoplay can
  // be blocked before the first user gesture; the play button still works.
  useEffect(() => {
    setEvaluationResult(null);
    setHasTransitionCanceled(false);

    if (currentCard?.front_audio_path) {
      setLastClickedAudio('front');
      audio.playAudio(currentCard.front_audio_path).catch(() => {});
    } else {
      setLastClickedAudio(null);
    }

    if (currentCard?.back_audio_path) {
      audio.loadAudio(currentCard.back_audio_path).catch(err => {
        console.error('Error preloading back audio:', err);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        <button
          onClick={() => navigate(`/deck/${currentDeckId}/voice`)}
          className="back-btn"
          title="Practice with a live voice conversation"
        >
          <ChatBubbleLeftRightIcon className="h-5 w-5" /> Voice mode
        </button>
      </div>

      <div className="review-controls" style={{ height: '100px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
        {isEvaluating ? (
          <div className="evaluation-loading">Evaluating your speech...</div>
        ) : evaluationResult ? (
          <div className={`evaluation-result ${evaluationResult.result}`}>
            <p>{evaluationResult.message}</p>
            {evaluationResult.transcription && (
              <p className="evaluation-transcription" style={{ opacity: 0.7, fontSize: '0.85rem', margin: '0.25rem 0 0' }}>
                Heard: “{evaluationResult.transcription}”
              </p>
            )}
            {evaluationResult.result === 'incorrect' && !isTransitioning && (
              <button
                onClick={handleOverrideCorrect}
                style={{ marginTop: '0.4rem', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', color: 'inherit', fontSize: '0.85rem', padding: 0 }}
                title="You judge your own pronunciation — override the AI's verdict"
              >
                Actually, I said it right
              </button>
            )}
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