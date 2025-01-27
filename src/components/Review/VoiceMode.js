import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MicrophoneIcon, ForwardIcon } from '@heroicons/react/24/solid';
import { useReview } from '../../hooks/useReview';
import AudioVisualizer from './AudioVisualizer';
import './VoiceMode.css';
import { useRealtimeAPI } from '../../hooks/useRealtimeAPI';
import { getRealtimeToken } from '../../network/api';
import { setupRealtimeStream } from '../../network/openai';

const VoiceMode = () => {
  const review = useReview();
  const currentCard = review.dueCards[review.currentCardIndex];

  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [feedback, setFeedback] = useState('Click microphone to start');
  const [isConnected, setIsConnected] = useState(false);
  const [buttonState, setButtonState] = useState('default'); // 'default', 'success', 'error'
  const [hasStarted, setHasStarted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [audioScale, setAudioScale] = useState(0);
  const [hasActiveResponse, setHasActiveResponse] = useState(false);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const audioElementRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const animationFrameRef = useRef(null);
  const aiAnimationFrameRef = useRef(null);

  const setupWebRTC = useCallback(async () => {
    try {
      // Get ephemeral token from our server
      const EPHEMERAL_KEY = await getRealtimeToken();

      // Create peer connection with STUN servers
      const pc = new RTCPeerConnection({ });
      peerConnectionRef.current = pc;

      // Set up audio playback
      audioElementRef.current = new Audio();
      audioElementRef.current.autoplay = true;
      pc.ontrack = e => {
        audioElementRef.current.srcObject = e.streams[0];
      };

      // Add local audio track
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      pc.addTrack(stream.getTracks()[0], stream);

      // Set up data channel
      const dc = pc.createDataChannel("oai-events");
      dataChannelRef.current = dc;

      dc.onopen = () => {
        setIsConnected(true);
        setFeedback('Click the microphone to begin');
        configureSession(currentCard);
      };

      dc.onclose = () => {
        setIsConnected(false);
        setFeedback('Connection lost');
      };

      dc.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === 'response.text.delta') {
          setIsSpeaking(true);
          setHasActiveResponse(true);
          // Clear any previous timeout
          if (window.speakingTimeoutId) {
            clearTimeout(window.speakingTimeoutId);
          }
          // Set a timeout to mark speaking as done if no new delta arrives
          window.speakingTimeoutId = setTimeout(() => {
            setIsSpeaking(false);
          }, 500);
        }
        handleRealtimeEvent(event);
      };

      // Log ICE connection state changes only for problematic states
      pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          console.error('ICE connection state:', pc.iceConnectionState);
        }
      };

      // Create and set local description
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Get remote description from OpenAI
      const answer = await setupRealtimeStream(offer, EPHEMERAL_KEY);
      await pc.setRemoteDescription(answer);

    } catch (error) {
      console.error('Error setting up WebRTC:', error);
      setFeedback('Failed to connect: ' + error.message);
      setIsConnected(false);
    }
  }, [currentCard]);

  const { handleRealtimeEvent, showSkip, configureSession } = useRealtimeAPI(mediaStreamRef, hasActiveResponse, review, peerConnectionRef, setIsConnected, setHasStarted, setIsSpeaking, setHasActiveResponse, setFeedback, isRecording, setIsRecording, animationFrameRef, setAudioScale, setButtonState, currentCard, dataChannelRef);

  // Update cleanup effect
  useEffect(() => {
    return () => {
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      if (audioElementRef.current) {
        audioElementRef.current.srcObject = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (aiAnimationFrameRef.current) {
        cancelAnimationFrame(aiAnimationFrameRef.current);
      }
      if (window.speakingTimeoutId) {
        clearTimeout(window.speakingTimeoutId);
      }
    };
  }, []);

  const handleMicClick = async () => {
    if (!hasStarted) {
      setIsConnecting(true);
      setFeedback('Connecting...');
      try {
        await setupWebRTC();
        setHasStarted(true);
      } catch (error) {
        setFeedback('Failed to connect: ' + error.message);
        setIsConnecting(false);
      }
      return;
    }

    if (isRecording) {
      setIsRecording(false);
    } else {
      setIsRecording(true);
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
        Attempts: {review.attempts}/3
      </div>
    </div>
  );
};

export default VoiceMode; 