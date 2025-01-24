import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MicrophoneIcon, ForwardIcon } from '@heroicons/react/24/solid';
import { useReview } from '../../hooks/useReview';
import './VoiceMode.css';

const VoiceMode = () => {
  const review = useReview();
  const currentCard = review.dueCards[review.currentCardIndex];
  
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [feedback, setFeedback] = useState('Click microphone to start');
  const [isConnected, setIsConnected] = useState(false);
  const [buttonState, setButtonState] = useState('default'); // 'default', 'success', 'error'
  const [showSkip, setShowSkip] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [audioScale, setAudioScale] = useState(0);
  const peerConnectionRef = useRef(null);
  const dataChannelRef = useRef(null);
  const audioElementRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const animationFrameRef = useRef(null);

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
        setFeedback('Click the microphone to begin');

        // Set up initial session configuration with function calling
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: `You are a friendly language learning tutor. First, give a brief welcome and explain that you'll help practice pronunciation.
            For each card: pronounce the front text and wait for the user to respond with the translation.
            If they say "again", repeat the front text.
            If they say "skip", "idk", or "next", mark it as incorrect and skipped.
            If they pronounce it incorrectly, mark it as incorrect and have them try again.
            If they pronounce it correctly, mark it as correct and move to the next card.
            When there are no more cards, give a brief goodbye and encouragement.
            Current card - Front: "${currentCard.frontText}", Back: "${currentCard.backText}"`,
            tools: [{
              type: 'function',
              name: 'evaluatePronunciation',
              description: 'Evaluate the pronunciation of a spoken phrase against an expected text.',
              parameters: {
                type: 'object',
                properties: {
                  result: {
                    type: 'string',
                    enum: ['correct', 'incorrect', 'quit'],
                    description: 'The evaluation result'
                  },
                  message: {
                    type: 'string',
                    description: 'Feedback message explaining the evaluation'
                  }
                },
                required: ['result', 'message']
              }
            }, {
              type: 'function',
              name: 'getNextCard',
              description: 'Get the next card in the deck.',
              parameters: {
                type: 'object',
                properties: {},
                required: []
              }
            }],
            tool_choice: 'auto'
          }
        }));

        // Start the interaction by having the AI pronounce the front text
        dc.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Pronounce the front text: "${currentCard.frontText}" clearly and wait for the user's response.`
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
      case 'response.output_item.done':
        const { item } = event;
        if (item.type === 'function_call') {
          if (item.name === 'evaluatePronunciation') {
            const args = JSON.parse(item.arguments);
            setFeedback(args.message);
            
            // Handle visual feedback based on result
            if (args.result === 'correct') {
              setButtonState('success');
              setTimeout(() => setButtonState('default'), 500);
              // Update card scheduling for correct answer
              review.updateCardScheduling(currentCard.created, 'correct');
              setTimeout(() => {
                review.moveToNextCard();
                // Request OpenAI to introduce the next card
                const nextCard = review.dueCards[review.currentCardIndex + 1];
                if (nextCard && dataChannelRef.current) {
                  dataChannelRef.current.send(JSON.stringify({
                    type: 'response.create',
                    response: {
                      instructions: `Pronounce the front text: "${nextCard.frontText}" clearly and wait for the user's response.`
                    }
                  }));
                }
              }, 2000);
            } else if (args.result === 'incorrect') {
              setButtonState('error');
              setTimeout(() => setButtonState('default'), 500);
              // Update card scheduling for incorrect answer
              review.updateCardScheduling(currentCard.created, 'incorrect');
              // Increment attempts
              review.setAttempts(prev => {
                const newAttempts = prev + 1;
                if (newAttempts >= 3) {
                  review.setShowAnswer(true);
                  setTimeout(() => {
                    review.moveToNextCard();
                    // Request OpenAI to introduce the next card
                    const nextCard = review.dueCards[review.currentCardIndex + 1];
                    if (nextCard && dataChannelRef.current) {
                      dataChannelRef.current.send(JSON.stringify({
                        type: 'response.create',
                        response: {
                          instructions: `Pronounce the front text: "${nextCard.frontText}" clearly and wait for the user's response.`
                        }
                      }));
                    }
                  }, 2000);
                }
                return newAttempts;
              });
            } else if (args.result === 'quit') {
              setShowSkip(true);
              setTimeout(() => setShowSkip(false), 500);
              // Mark as incorrect and move to next card
              review.updateCardScheduling(currentCard.created, 'incorrect');
              review.setShowAnswer(true);
              setTimeout(() => {
                review.moveToNextCard();
                // Request OpenAI to introduce the next card
                const nextCard = review.dueCards[review.currentCardIndex + 1];
                if (nextCard && dataChannelRef.current) {
                  dataChannelRef.current.send(JSON.stringify({
                    type: 'response.create',
                    response: {
                      instructions: `Pronounce the front text: "${nextCard.frontText}" clearly and wait for the user's response.`
                    }
                  }));
                }
              }, 500);
            }
            
            // Send the function result back
            dataChannelRef.current?.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: item.call_id,
                output: JSON.stringify({ result: args.result, message: args.message })
              }
            }));

            // Request the next response
            dataChannelRef.current?.send(JSON.stringify({
              type: 'response.create'
            }));
          } else if (item.name === 'getNextCard') {
            // Get the next card info from review hook
            const nextCardIndex = review.currentCardIndex + 1;
            const nextCard = review.dueCards[nextCardIndex];
            
            dataChannelRef.current?.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: item.call_id,
                output: JSON.stringify(nextCard ? {
                  frontText: nextCard.frontText,
                  backText: nextCard.backText,
                  hasMore: nextCardIndex < review.dueCards.length - 1
                } : null)
              }
            }));

            // Request the next response
            dataChannelRef.current?.send(JSON.stringify({
              type: 'response.create'
            }));
          }
        }
        break;
      case 'error':
        console.error('Realtime API Error:', event.error);
        setFeedback('Error: ' + event.error);
        break;
      default:
        console.log('Received event:', event);
    }
  };

  // Add audio visualization
  const setupAudioVisualization = useCallback((stream) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    
    if (!analyserRef.current) {
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
    }

    const source = audioContextRef.current.createMediaStreamSource(stream);
    source.connect(analyserRef.current);

    const updateVolume = () => {
      if (!analyserRef.current) return;

      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      const volume = Math.min(average / 128, 1); // Normalize to 0-1
      setAudioScale(volume * 100);

      animationFrameRef.current = requestAnimationFrame(updateVolume);
    };

    updateVolume();
  }, []);

  // Update startRecording to include visualization
  const startRecording = async () => {
    if (!isConnected) {
      setFeedback('Not connected. Please wait...');
      return;
    }

    setIsRecording(true);
    setFeedback('Listening...');

    // Set up audio visualization
    if (mediaStreamRef.current) {
      setupAudioVisualization(mediaStreamRef.current);
    }

    // Clear any existing audio buffer
    if (dataChannelRef.current) {
      dataChannelRef.current.send(JSON.stringify({
        type: 'input_audio_buffer.clear'
      }));
    }
  };

  // Update stopRecording to cleanup visualization
  const stopRecording = () => {
    if (isRecording && dataChannelRef.current) {
      setIsRecording(false);
      
      // Stop audio visualization
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      setAudioScale(0);
      
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

  // Add audio element event handlers
  useEffect(() => {
    if (!audioElementRef.current) return;

    const handlePlay = () => {
      console.log('AI started speaking');
      setIsSpeaking(true);
    };

    const handleEnded = () => {
      console.log('AI finished speaking');
      setIsSpeaking(false);
    };

    audioElementRef.current.addEventListener('play', handlePlay);
    audioElementRef.current.addEventListener('ended', handleEnded);

    return () => {
      if (audioElementRef.current) {
        audioElementRef.current.removeEventListener('play', handlePlay);
        audioElementRef.current.removeEventListener('ended', handleEnded);
      }
    };
  }, []);

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
    };
  }, []);

  const handleMicClick = async () => {
    if (!hasStarted) {
      setIsConnecting(true);
      setFeedback('Connecting...');
      try {
        await setupWebRTC();
        setHasStarted(true);
        // Start the session with welcome message
        dataChannelRef.current?.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: 'Give a brief, friendly welcome and explain that you\'ll help them practice pronunciation. Then pronounce the first card.'
          }
        }));
      } catch (error) {
        setFeedback('Failed to connect: ' + error.message);
        setIsConnecting(false);
      }
      return;
    }

    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <div className="voice-mode">
      <div className="voice-interface">
        <button 
          className={`mic-button ${isRecording ? 'recording' : ''} ${isSpeaking ? 'speaking' : ''} ${!isConnected && hasStarted ? 'disabled' : ''} ${buttonState}`}
          onClick={handleMicClick}
          disabled={(hasStarted && !isConnected) || isSpeaking || isConnecting}
          style={{ '--scale': `${audioScale}%` }}
        >
          <div className="audio-visualizer" />
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