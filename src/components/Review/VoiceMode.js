import React, { useEffect, useState } from 'react';
import { MicrophoneIcon, ForwardIcon } from '@heroicons/react/24/solid';
import { useReview } from '../../hooks/useReview';
import AudioVisualizer from './AudioVisualizer';
import './VoiceMode.css';
import { useRealtime } from '../../contexts/RealtimeContext';

const VoiceMode = () => {
  const review = useReview();
  const { currentCardId, cardsById, attempts, cardSchedulerRef } = review;
  const [isConnecting, setIsConnecting] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);

  const {
    isConnected,
    isSpeaking,
    isRecording,
    feedback,
    buttonState,
    audioScale,
    showSkip,
    mediaStreamRef,
    audioElementRef,
    audioContextRef,
    animationFrameRef,
    aiAnimationFrameRef,
    peerConnectionRef,
    setupWebRTC,
    cleanup,
    setIsRecording,
    setAudioScale,
    setFeedback,
  } = useRealtime();

  const onAudioStopped = () => {
    console.log('onAudioStopped');
    const currentCard = cardsById[currentCardId];
    console.log('currentCard info: ' + JSON.stringify(currentCard));
    if (cardSchedulerRef.current.peekNext() == null) {
      console.log('oh no, cardSchedulerRef is empty, shutting down');
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
    }
  }

  // Update cleanup effect
  useEffect(() => {
    // Only run cleanup when component unmounts
    return () => {
      cleanup();
    };
  }, []); // Empty dependency array means only run on unmount

  const handleMicClick = async () => {
    if (!hasStarted) {
      setIsConnecting(true);
      setFeedback('Connecting...');
      try {
        const currentCard = cardsById[currentCardId];
        const success = await setupWebRTC(currentCard, review, onAudioStopped);

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

    const newRecordingState = !isRecording;
    console.log('Toggling recording:', newRecordingState, {
      mediaStream: mediaStreamRef.current ? {
        active: mediaStreamRef.current.active,
        tracks: mediaStreamRef.current.getTracks().map(track => ({
          enabled: track.enabled,
          readyState: track.readyState
        }))
      } : null
    });
    setIsRecording(newRecordingState);

    // Ensure tracks are enabled when we start recording
    if (newRecordingState && mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => {
        track.enabled = true;
        console.log(`Enabled track ${track.id}:`, {
          enabled: track.enabled,
          readyState: track.readyState
        });
      });
    }
  };

  return (
    <div className="voice-mode">
      <div className="voice-interface">
        <div className="visualization-container">
          <div className="visualizer user">
            <AudioVisualizer
              audioStream={mediaStreamRef.current}
              isLive={isRecording}
              isAiOutput={false}
              audioContextRef={audioContextRef}
              animationFrameRef={animationFrameRef}
              onVolumeChange={setAudioScale}
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
          disabled={(hasStarted && !isConnected) || isSpeaking || isConnecting}
          style={{ '--scale': `${audioScale}%` }}
        >
          <MicrophoneIcon className="large-mic-icon" />
        </button>
        {showSkip && (
          <div className="skip-indicator show">
            <ForwardIcon />
          </div>
        )}
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