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
  const canvasRef = useRef(null);
  const canvasCtxRef = useRef(null);

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
        // Set up visualization for AI output
        if (audioContextRef.current && analyserRef.current) {
          const outputSource = audioContextRef.current.createMediaStreamSource(e.streams[0]);
          outputSource.connect(analyserRef.current);
        }
      };

      // Add local audio track
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      pc.addTrack(stream.getTracks()[0], stream);

      // Initialize visualization
      setupAudioVisualization(stream);

      // Set up data channel
      const dc = pc.createDataChannel("oai-events");
      dataChannelRef.current = dc;

      dc.onopen = () => {
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
            }, {
              type: 'function',
              name: 'completeReview',
              description: 'Called when the review session is complete.',
              parameters: {
                type: 'object',
                properties: {
                  message: {
                    type: 'string',
                    description: 'Final message to show to the user'
                  }
                },
                required: ['message']
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
        setIsConnected(false);
        setFeedback('Connection lost');
      };

      dc.onmessage = (e) => {
        const event = JSON.parse(e.data);
        if (event.type === 'response.text.delta') {
          setIsSpeaking(true);
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
                } else if (dataChannelRef.current) {
                  // No more cards, request a farewell message
                  dataChannelRef.current.send(JSON.stringify({
                    type: 'response.create',
                    response: {
                      instructions: 'Give a brief farewell message congratulating the user on completing their review session, then call the completeReview function.'
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
          } else if (item.name === 'completeReview') {
            const args = JSON.parse(item.arguments);
            setFeedback(args.message);
            
            // Clean up the session
            if (mediaStreamRef.current) {
              mediaStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (peerConnectionRef.current) {
              peerConnectionRef.current.close();
            }
            setIsConnected(false);
            setHasStarted(false);
            
            // Send function result back
            dataChannelRef.current?.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: item.call_id,
                output: JSON.stringify({ success: true })
              }
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
        //console.log('Received event:', event);
        break;
    }
  };

  // Add audio visualization first
  const setupAudioVisualization = useCallback((stream) => {
    console.log('Setting up audio visualization');
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      console.log('Created new AudioContext');
    }
    
    if (!analyserRef.current) {
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      console.log('Created new AnalyserNode with fftSize:', analyserRef.current.fftSize);
    }

    // Create new source for each visualization
    const source = audioContextRef.current.createMediaStreamSource(stream);
    source.connect(analyserRef.current);
    console.log('Connected audio source to analyser');

    // Set up canvas
    const canvas = canvasRef.current;
    if (!canvas) {
      console.error('Canvas element not found');
      return;
    }
    
    // Set actual pixel dimensions
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    console.log('Canvas dimensions:', { width: canvas.width, height: canvas.height, dpr });
    
    const ctx = canvas.getContext('2d');
    canvasCtxRef.current = ctx;
    ctx.scale(dpr, dpr);

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const WIDTH = rect.width;
    const HEIGHT = rect.height;
    const barWidth = (WIDTH / bufferLength) * 2.5;
    const barSpacing = 2;

    console.log('Visualization parameters:', { 
      bufferLength, 
      WIDTH, 
      HEIGHT, 
      barWidth,
      barSpacing
    });

    let frameCount = 0;
    const renderFrame = () => {
      if (!analyserRef.current || !canvasCtxRef.current) {
        console.error('Missing analyser or canvas context');
        return;
      }

      analyserRef.current.getByteFrequencyData(dataArray);

      // Calculate average for the circular visualization
      let sum = 0;
      let hasSound = false;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
        if (dataArray[i] > 5) { // Threshold to detect actual sound vs noise
          hasSound = true;
        }
      }
      const average = sum / dataArray.length;
      const volume = Math.min(average / 128, 1);
      
      // Only update scale if there's actual sound
      if (hasSound) {
        setAudioScale(volume * 100);
      }

      // Draw bar visualization
      const ctx = canvasCtxRef.current;
      ctx.clearRect(0, 0, WIDTH, HEIGHT);

      let x = 0;
      let maxBarHeight = 0;
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255.0) * HEIGHT * 0.8;
        maxBarHeight = Math.max(maxBarHeight, barHeight);
        
        // Always set a color based on state and sound detection
        if (hasSound) {
          if (isRecording) {
            // Rainbow gradient for recording
            const hue = (i / bufferLength) * 360;
            const lightness = 50 + (barHeight / HEIGHT) * 50;
            ctx.fillStyle = `hsl(${hue}, 100%, ${lightness}%)`;
          } else if (isSpeaking) {
            // Flame orange for AI speaking
            const intensity = barHeight / HEIGHT;
            ctx.fillStyle = `rgba(255, 107, 53, ${0.5 + intensity * 0.5})`;
          } else {
            // Default color - soft blue gradient when idle
            const intensity = barHeight / HEIGHT;
            ctx.fillStyle = `rgba(100, 149, 237, ${0.3 + intensity * 0.3})`;
          }
        } else {
          // Very dim color when no sound
          ctx.fillStyle = 'rgba(100, 100, 100, 0.1)';
        }
        
        // Draw bar with rounded corners
        const barX = x + barSpacing;
        const barY = HEIGHT - barHeight;
        const barW = barWidth - barSpacing * 2;
        const radius = Math.min(barW / 2, barHeight / 2, 4);

        ctx.beginPath();
        ctx.moveTo(barX + radius, barY);
        ctx.lineTo(barX + barW - radius, barY);
        ctx.quadraticCurveTo(barX + barW, barY, barX + barW, barY + radius);
        ctx.lineTo(barX + barW, HEIGHT - radius);
        ctx.quadraticCurveTo(barX + barW, HEIGHT, barX + barW - radius, HEIGHT);
        ctx.lineTo(barX + radius, HEIGHT);
        ctx.quadraticCurveTo(barX, HEIGHT, barX, HEIGHT - radius);
        ctx.lineTo(barX, barY + radius);
        ctx.quadraticCurveTo(barX, barY, barX + radius, barY);
        ctx.closePath();
        
        ctx.fill();
        
        x += barWidth;
      }

      frameCount++;
      if (frameCount % 60 === 0) { // Log every 60 frames
        console.log('Visualization stats:', { 
          frameCount, 
          maxBarHeight, 
          volume, 
          hasSound,
          isRecording, 
          isSpeaking 
        });
      }

      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    console.log('Starting render loop');
    renderFrame();

    return () => {
      console.log('Cleaning up visualization');
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      source.disconnect();
    };
  }, [isRecording, isSpeaking]);

  // Remove the mount effect since we'll initialize in setupWebRTC
  useEffect(() => {
    console.log('Mount effect - mediaStream:', !!mediaStreamRef.current);
    if (mediaStreamRef.current) {
      setupAudioVisualization(mediaStreamRef.current);
    }
  }, [setupAudioVisualization]);

  // Remove the audio element handlers since we're tracking speaking state from events
  useEffect(() => {
    if (!audioElementRef.current) return;

    const handleEnded = () => {
      setIsSpeaking(false);
    };

    audioElementRef.current.addEventListener('ended', handleEnded);

    return () => {
      if (audioElementRef.current) {
        audioElementRef.current.removeEventListener('ended', handleEnded);
      }
    };
  }, []);

  // Then add recording handlers
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
        <div className="visualization-container">
          <canvas ref={canvasRef} className="audio-canvas" />
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