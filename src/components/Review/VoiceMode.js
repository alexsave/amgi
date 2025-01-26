import React, { useEffect, useRef, useState, useCallback } from 'react';
import { MicrophoneIcon, ForwardIcon } from '@heroicons/react/24/solid';
import { useReview } from '../../hooks/useReview';
import AudioVisualizer from './AudioVisualizer';
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
        setIsConnected(true);
        setFeedback('Click the microphone to begin');

        // Set up initial session configuration with function calling
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: `You are a friendly language learning tutor. First, give a brief welcome and explain that you'll help practice pronunciation.
            For each card: clearly say the front text (${currentCard.frontText}) and wait for the user to respond with the TRANSLATION (${currentCard.backText}).
            
            After EVERY user response (except "again"), you must:
            1. Evaluate their response using the evaluatePronunciation function:
               - result="correct" if they correctly translate AND pronounce "${currentCard.backText}"
               - result="incorrect" if they say anything else (wrong translation, wrong pronunciation, or if they repeat "${currentCard.frontText}")
               - result="quit" if they say "skip", "idk", or "next"
            2. After the function returns, give brief feedback based on the result
            
            Special cases:
            - If they say "again", just repeat "${currentCard.frontText}" clearly
            - For incorrect responses, encourage them to try again
            - For correct responses, give quick praise before moving on
            
            Keep your responses friendly but concise. Focus on helping them learn.
            
            When there are no more cards, give a brief goodbye and encouragement.
            Current card - Front: "${currentCard.frontText}", Back (expected translation): "${currentCard.backText}"`,
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

        // Start with a welcome message and introduce the first card
        dc.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Give a brief, friendly welcome and explain that you'll help them practice pronunciation and translation. Explain that you'll say a phrase, and they should respond with the correct translation. After the welcome, say "Let's start with our first card" and then clearly say: "${currentCard.frontText}" and wait for the user to respond with the translation.`
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
      case 'output_audio_buffer.audio_started':
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = false;
          });
        }
        break;

      case 'output_audio_buffer.audio_stopped':
        console.log('input_audio_buffer.speech_stopped - unmuting microphone');
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getAudioTracks().forEach(track => {
            track.enabled = true;
          });
        }
        // If we're in a completed state and the AI just finished speaking, clean up
        if (!hasActiveResponse && review.currentCardIndex >= review.dueCards.length - 1) {
          console.log('AI finished farewell message, cleaning up connection');
          setTimeout(() => {
            if (mediaStreamRef.current) {
              mediaStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (peerConnectionRef.current) {
              peerConnectionRef.current.close();
            }
            setIsConnected(false);
            setHasStarted(false);
          }, 500);
        }
        break;

      case 'response.text.delta':
        setIsSpeaking(true);
        setHasActiveResponse(true);
        setFeedback(prev => prev + event.delta);
        // Stop recording if we were recording when AI starts speaking
        if (isRecording) {
          setIsRecording(false);
          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
          }
          setAudioScale(0);
        }
        // Clear any previous timeout
        if (window.speakingTimeoutId) {
          clearTimeout(window.speakingTimeoutId);
        }
        // Set a timeout to mark speaking as done if no new delta arrives
        window.speakingTimeoutId = setTimeout(() => {
          setIsSpeaking(false);
        }, 500);
        break;
      case 'response.output_item.done':
        const { item } = event;
        if (item.type === 'function_call') {
          console.log('Received function call:', { name: item.name, arguments: JSON.parse(item.arguments) }, '- Processing user response and updating UI accordingly');
          if (item.name === 'evaluatePronunciation') {
            const args = JSON.parse(item.arguments);
            setFeedback(args.message);
            
            // Handle visual feedback based on result
            if (args.result === 'correct') {
              setButtonState('success');
              setTimeout(() => setButtonState('default'), 500);
              // Update card scheduling for correct answer
              review.updateCardScheduling(currentCard.created, 'correct');
              
              // Calculate next index and check if it would be the last card
              const nextIndex = review.currentCardIndex + 1;
              const isLastCard = nextIndex >= review.dueCards.length;
              
              // Get next card info
              const nextCard = isLastCard ? null : review.dueCards[nextIndex];
              
              // Only move to next card if there is one
              if (!isLastCard) {
                review.moveToNextCard();
              }
              
              // Send the function result back with next card info
              console.log('Evaluating next card status:', {
                currentIndex: review.currentCardIndex,
                nextIndex,
                totalCards: review.dueCards.length,
                isLastCard,
                hasNextCard: !!nextCard,
                explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
              });
              dataChannelRef.current?.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: item.call_id,
                  output: JSON.stringify({
                    result: args.result,
                    message: args.message,
                    nextCard: nextCard ? {
                      frontText: nextCard.frontText,
                      backText: nextCard.backText
                    } : null,
                    hasMoreCards: !isLastCard
                  })
                }
              }));
              
              // If this was the last card, call completeReview
              if (isLastCard) {
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call',
                    name: 'completeReview',
                    arguments: JSON.stringify({
                      message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                    })
                  }
                }));
              }
              
              // Request next response if no active response
              if (!hasActiveResponse) {
                console.log('Requesting next response after correct answer');
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'response.create'
                }));
              }

            } else if (args.result === 'incorrect') {
              setButtonState('error');
              setTimeout(() => setButtonState('default'), 500);
              review.updateCardScheduling(currentCard.created, 'incorrect');
              
              // Update attempts and handle max attempts case
              let shouldMoveToNext = false;
              let nextCard = null;

              review.setAttempts(prev => {
                const newAttempts = prev + 1;
                if (newAttempts >= 3) {
                  shouldMoveToNext = true;
                }
                return newAttempts;
              });

              // Handle max attempts case outside setState
              if (shouldMoveToNext) {
                review.setShowAnswer(true);
                
                // Calculate next index and check if it would be the last card
                const nextIndex = review.currentCardIndex + 1;
                const isLastCard = nextIndex >= review.dueCards.length;
                
                // Get next card info
                const nextCard = isLastCard ? null : review.dueCards[nextIndex];
                
                // Only move to next card if there is one
                if (!isLastCard) {
                  review.moveToNextCard();
                }
                
                // Send function result with next card info after max attempts
                console.log('Evaluating next card status (max attempts):', {
                  currentIndex: review.currentCardIndex,
                  nextIndex,
                  totalCards: review.dueCards.length,
                  isLastCard,
                  hasNextCard: !!nextCard,
                  explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
                });
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: item.call_id,
                    output: JSON.stringify({
                      result: 'skip',
                      message: 'Moving to next card after maximum attempts',
                      nextCard: nextCard ? {
                        frontText: nextCard.frontText,
                        backText: nextCard.backText
                      } : null,
                      hasMoreCards: !isLastCard
                    })
                  }
                }));

                // If this was the last card, call completeReview
                if (isLastCard) {
                  dataChannelRef.current?.send(JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                      type: 'function_call',
                      name: 'completeReview',
                      arguments: JSON.stringify({
                        message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                      })
                    }
                  }));
                }
              } else {
                // Just acknowledge the incorrect attempt
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: item.call_id,
                    output: JSON.stringify({
                      result: args.result,
                      message: args.message
                    })
                  }
                }));
              }

              // Request next response if no active response
              if (!hasActiveResponse) {
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'response.create'
                }));
              }

            } else if (args.result === 'quit' || args.result === 'skip') {
              setShowSkip(true);
              setTimeout(() => setShowSkip(false), 500);
              // Mark as incorrect and move to next card
              review.updateCardScheduling(currentCard.created, 'incorrect');
              review.setShowAnswer(true);
              
              // Calculate next index and check if it would be the last card
              const nextIndex = review.currentCardIndex + 1;
              const isLastCard = nextIndex >= review.dueCards.length;
              
              // Get next card info
              const nextCard = isLastCard ? null : review.dueCards[nextIndex];
              
              // Only move to next card if there is one
              if (!isLastCard) {
                review.moveToNextCard();
              }
              
              // Send function result with next card info
              console.log('Evaluating next card status (skip/quit):', {
                currentIndex: review.currentCardIndex,
                nextIndex,
                totalCards: review.dueCards.length,
                isLastCard,
                hasNextCard: !!nextCard,
                explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
              });
              dataChannelRef.current?.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: item.call_id,
                  output: JSON.stringify({
                    result: args.result,
                    message: args.message,
                    nextCard: nextCard ? {
                      frontText: nextCard.frontText,
                      backText: nextCard.backText
                    } : null,
                    hasMoreCards: !isLastCard
                  })
                }
              }));
              
              // If this was the last card, call completeReview
              if (isLastCard) {
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call',
                    name: 'completeReview',
                    arguments: JSON.stringify({
                      message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                    })
                  }
                }));
              }
              
              // Request next response if no active response
              if (!hasActiveResponse) {
                console.log('Requesting next response after skip');
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'response.create'
                }));
              }
            } else if (args.result === 'again') {
              // Just acknowledge the request to repeat
              console.log('Sending function_call_output for evaluatePronunciation:', { result: args.result }, '- Repeating current card');
              dataChannelRef.current?.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: item.call_id,
                  output: JSON.stringify({
                    result: args.result,
                    message: args.message
                  })
                }
              }));
              
              // Request next response if no active response
              if (!hasActiveResponse) {
                console.log('Requesting next response after again');
                dataChannelRef.current?.send(JSON.stringify({
                  type: 'response.create'
                }));
              }
            }
          } else if (item.name === 'completeReview') {
            const args = JSON.parse(item.arguments);
            setFeedback(args.message);
            
            // Send function result back first
            console.log('Sending function_call_output for completeReview - Finishing review session');
            dataChannelRef.current?.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: item.call_id,
                output: JSON.stringify({ success: true })
              }
            }));
            
            // Request final response if no active response
            if (!hasActiveResponse) {
              console.log('Requesting final response after review completion');
              dataChannelRef.current?.send(JSON.stringify({
                type: 'response.create'
              }));
            }
            
            // Don't close connection yet - we'll do it after the AI finishes speaking
          } else if (item.name === 'getNextCard') {
            // Get the next card info from review hook
            const nextCardIndex = review.currentCardIndex + 1;
            const nextCard = review.dueCards[nextCardIndex];
            
            console.log('Evaluating next card status (getNextCard):', {
              currentIndex: review.currentCardIndex,
              nextIndex: nextCardIndex,
              totalCards: review.dueCards.length,
              hasNextCard: !!nextCard,
              hasMore: nextCardIndex < review.dueCards.length - 1,
              explanation: `Current index is ${review.currentCardIndex}, next index would be ${nextCardIndex}, total cards is ${review.dueCards.length}. hasMore=${nextCardIndex < review.dueCards.length - 1} because ${nextCardIndex} ${nextCardIndex < review.dueCards.length - 1 ? '<' : '>='} ${review.dueCards.length - 1}`
            });
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

            // only request next response if there isn't an active one
            if (!hasActiveResponse) {
              console.log('sending response.create - no active response after getnextcard');
              dataChannelRef.current?.send(JSON.stringify({
                type: 'response.create'
              }));
            }
          }
        }
        break;
      case 'response.complete':
        setHasActiveResponse(false);
        setIsSpeaking(false);
        break;
      case 'error':
        console.error('realtime api error:', event.error);
        setFeedback('error: ' + event.error.message);
        if (event.error.message === 'conversation already has an active response') {
          setHasActiveResponse(true);
        }
        break;
      default:
        //console.log('received event:', event);
        break;
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
              isRecording={isRecording}
              isSpeaking={false}
              isAiOutput={false}
              audioContextRef={audioContextRef}
              animationFrameRef={animationFrameRef}
              onVolumeChange={setAudioScale}
            />
          </div>
          <div className="visualizer ai">
            <AudioVisualizer
              audioStream={audioElementRef.current?.srcObject}
              isRecording={false}
              isSpeaking={isSpeaking}
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