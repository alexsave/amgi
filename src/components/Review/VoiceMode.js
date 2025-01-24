import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MicrophoneIcon } from '@heroicons/react/24/solid';
import './VoiceMode.css';

const VoiceMode = ({ currentCard }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const audioElementRef = useRef(null);
  const mediaStreamRef = useRef(null);

  const setupWebRTC = useCallback(async () => {
    try {
      // Get ephemeral token
      const tokenResponse = await fetch("http://localhost:8000/api/realtime-token");
      if (!tokenResponse.ok) {
        throw new Error(`Failed to get token: ${tokenResponse.statusText}`);
      }
      
      const data = await tokenResponse.json();
      if (!data.client_secret?.value) {
        throw new Error('Invalid token response');
      }
      
      const EPHEMERAL_KEY = data.client_secret.value;

      // Create peer connection with STUN servers
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' }
        ]
      });
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
        console.log('Data channel opened');
        setIsConnected(true);
        setFeedback('');

        // Set up initial session configuration
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: `You are a helpful language learning tutor. The user is practicing with flashcards. 
            The current card's front text is "${currentCard.frontText}" and back text is "${currentCard.backText}".
            Help the user practice pronunciation, answer questions about the word/phrase, or provide examples.
            Keep responses brief and focused.`,
          }
        }));
      };

      dc.onclose = () => {
        console.log('Data channel closed');
        setIsConnected(false);
        setFeedback('Connection lost');
      };

      dc.onmessage = (e) => {
        const event = JSON.parse(e.data);
        handleRealtimeEvent(event);
      };

      // Log ICE connection state changes
      pc.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', pc.iceConnectionState);
      };

      // Create and set local description
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Get remote description from OpenAI
      const baseUrl = "https://api.openai.com/v1/realtime";
      const model = "gpt-4o-realtime-preview-2024-12-17";
      const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${EPHEMERAL_KEY}`,
          "Content-Type": "application/sdp"
        },
      });

      if (!sdpResponse.ok) {
        throw new Error(`Failed to get remote description: ${sdpResponse.statusText}`);
      }

      const answer = {
        type: "answer",
        sdp: await sdpResponse.text(),
      };
      await pc.setRemoteDescription(answer);

    } catch (error) {
      console.error('Error setting up WebRTC:', error);
      setFeedback('Failed to connect: ' + error.message);
      setIsConnected(false);
    }
  }, [currentCard]);

  const handleRealtimeEvent = (event) => {
    switch (event.type) {
      case 'response.text.delta':
        setFeedback(prev => prev + event.delta);
        break;
      case 'error':
        console.error('Realtime API Error:', event.error);
        setFeedback('Error: ' + event.error);
        break;
      default:
        console.log('Received event:', event);
    }
  };

  useEffect(() => {
    setupWebRTC();

    return () => {
      // Cleanup
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }
      if (audioElementRef.current) {
        audioElementRef.current.srcObject = null;
      }
    };
  }, [setupWebRTC]);

  const startRecording = async () => {
    if (!isConnected) {
      setFeedback('Not connected. Please wait...');
      return;
    }

    setIsRecording(true);
    setFeedback('Listening...');

    // Clear any existing audio buffer
    if (dataChannelRef.current) {
      dataChannelRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.clear'
      }));
    }
  };

  const stopRecording = () => {
    if (isRecording && dataChannelRef.current) {
      setIsRecording(false);
      
      // Commit the audio buffer and create a response
      dataChannelRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.commit'
      }));
      
      dataChannelRef.current.send(JSON.stringify({
        type: 'response.create'
      }));
      
      setFeedback('Processing...');
    }
  };

  // Add audio processing
  useEffect(() => {
    if (!mediaStreamRef.current || !dataChannelRef.current || !isRecording) {
      return;
    }

    const mediaRecorder = new MediaRecorder(mediaStreamRef.current);
    const chunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
        // Convert to base64 and send
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Audio = reader.result.split(',')[1];
          if (dataChannelRef.current?.readyState === 'open') {
            dataChannelRef.current.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              buffer: base64Audio
            }));
          }
        };
        reader.readAsDataURL(event.data);
      }
    };

    mediaRecorder.start(100); // Send chunks every 100ms

    return () => {
      mediaRecorder.stop();
    };
  }, [isRecording]);

  return (
    <div className="voice-mode">
      <div className="voice-interface">
        <button 
          className={`mic-button ${isRecording ? 'recording' : ''} ${!isConnected ? 'disabled' : ''}`}
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onMouseLeave={stopRecording}
          disabled={!isConnected}
        >
          <MicrophoneIcon className="large-mic-icon" />
        </button>
      </div>
      {feedback && (
        <div className="feedback-message">
          {feedback}
        </div>
      )}
    </div>
  );
};

export default VoiceMode; 