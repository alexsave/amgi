import React, { useEffect, useState } from 'react';
import { MicrophoneIcon } from '@heroicons/react/24/solid';
import { useNavigate } from 'react-router-dom';
import { useReview } from '../../contexts/ReviewContext';
import { useDecks } from '../../contexts/DeckContext';
import AudioVisualizer from './AudioVisualizer';
import './VoiceMode.css';
import { useRealtime } from '../../contexts/RealtimeContext';

/**
 * Live conversation practice: a WebRTC session with the realtime model that
 * walks through the due cards, evaluates the user's spoken answers, and
 * advances the same spaced-repetition scheduler as the classic review mode.
 */
const VoiceMode = () => {
  const review = useReview();
  const navigate = useNavigate();
  const { decks, currentDeckId } = useDecks();
  const { attempts, currentCard } = review;
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  const {
    isConnected,
    isSpeaking,
    isRecording,
    feedback,
    buttonState,
    mediaStreamRef,
    audioElementRef,
    audioContextRef,
    animationFrameRef,
    aiAnimationFrameRef,
    setupWebRTC,
    cleanup,
    setIsRecording,
    setFeedback,
  } = useRealtime();

  // Tear down the WebRTC session when leaving the page.
  useEffect(() => {
    return () => {
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBack = () => {
    review.syncCardsToDeck();
    navigate('/decks');
  };

  const handleMicClick = async () => {
    if (!hasStarted) {
      setIsConnecting(true);
      setFeedback('Connecting...');
      try {
        const success = await setupWebRTC();
        if (success) {
          setHasStarted(true);
        }
      } catch (error) {
        console.error('Failed to connect:', error);
        setFeedback('Failed to connect: ' + error.message);
      }
      setIsConnecting(false);
      return;
    }

    // setIsRecording also mutes/unmutes the actual mic tracks, so toggling
    // off really stops streaming audio to the model.
    setIsRecording(!isRecording);
  };

  if (!currentCard) {
    return (
      <div className="review-complete">
        <h3>🎉 Review Complete!</h3>
        <p>You've reviewed all due cards in this deck.</p>
        <button onClick={handleBack} className="back-btn">
          Back to Decks
        </button>
      </div>
    );
  }

  return (
    <div className="voice-mode">
      <div className="mode-header">
        <button onClick={handleBack} className="back-btn">
          ← Decks
        </button>
        <h2>{decks[currentDeckId]?.name}</h2>
        <button
          onClick={() => navigate(`/deck/${currentDeckId}/review`)}
          className="back-btn"
          title="Switch to classic review"
        >
          Classic mode
        </button>
      </div>
      <div className="voice-interface">
        <div className="visualization-container">
          <div className="visualizer user">
            <AudioVisualizer
              audioStream={mediaStreamRef.current}
              isLive={isRecording}
              isAiOutput={false}
              audioContextRef={audioContextRef}
              animationFrameRef={animationFrameRef}
            />
          </div>
          <div className="visualizer ai">
            <AudioVisualizer
              audioStream={audioElementRef.current?.srcObject}
              isLive={isSpeaking}
              isAiOutput={true}
              audioContextRef={audioContextRef}
              animationFrameRef={aiAnimationFrameRef}
            />
          </div>
        </div>
        <button
          className={`mic-button ${isRecording ? 'recording' : ''} ${isSpeaking ? 'speaking' : ''} ${!isConnected && hasStarted ? 'disabled' : ''} ${buttonState}`}
          onClick={handleMicClick}
          disabled={(hasStarted && !isConnected) || isConnecting}
        >
          <MicrophoneIcon className="large-mic-icon" />
        </button>
      </div>
      {feedback && (
        <div className="feedback-message">
          {feedback}
        </div>
      )}
      <div className="attempts-counter">
        Attempts: {attempts}/3
      </div>
    </div>
  );
};

export default VoiceMode;
