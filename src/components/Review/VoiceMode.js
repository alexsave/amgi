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
    const [hasActiveResponse, setHasActiveResponse] = useState(false);
    const peerConnectionRef = useRef(null);
    const dataChannelRef = useRef(null);
    const audioElementRef = useRef(null);
    const mediaStreamRef = useRef(null);
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const aiAnalyserRef = useRef(null);
    const animationFrameRef = useRef(null);
    const aiAnimationFrameRef = useRef(null);
    const canvasRef = useRef(null);
    const aiCanvasRef = useRef(null);
    const canvasCtxRef = useRef(null);
    const aiCanvasCtxRef = useRef(null);

    const sendDataChannelMessage = useCallback((message) => {
        if (!dataChannelRef.current) return;
        dataChannelRef.current.send(JSON.stringify(message));
    }, []);

    const requestNextResponse = useCallback(() => {
        if (!hasActiveResponse) {
            console.log('Requesting next response');
            sendDataChannelMessage({
                type: 'response.create'
            });
        }
    }, [hasActiveResponse]);

    const sendFunctionCallOutput = useCallback((callId, result, message, nextCardInfo = null) => {
        if (!dataChannelRef.current) return;

        const nextIndex = review.currentCardIndex + 1;
        const isLastCard = nextIndex >= review.dueCards.length;
        const nextCard = nextCardInfo || (!isLastCard ? review.dueCards[nextIndex] : null);

        console.log('Evaluating next card status:', {
            currentIndex: review.currentCardIndex,
            nextIndex,
            totalCards: review.dueCards.length,
            isLastCard,
            hasNextCard: !!nextCard,
            explanation: `Current card index is ${review.currentCardIndex}, next index would be ${nextIndex}, total cards is ${review.dueCards.length}. isLastCard=${isLastCard} because ${nextIndex} ${isLastCard ? '>=' : '<'} ${review.dueCards.length}`
        });

        sendDataChannelMessage({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({
                    result,
                    message,
                    nextCard: nextCard ? {
                        frontText: nextCard.frontText,
                        backText: nextCard.backText
                    } : null,
                    hasMoreCards: !isLastCard
                })
            }
        });

        if (isLastCard) {
            sendDataChannelMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call',
                    name: 'completeReview',
                    arguments: JSON.stringify({
                        message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                    })
                }
            });
        }

        requestNextResponse();
    }, [review.currentCardIndex, review.dueCards.length, requestNextResponse, sendDataChannelMessage]);

    const handleIncorrectResponse = (item, args) => {
        setButtonState('error');
        setTimeout(() => setButtonState('default'), 500);
        review.updateCardScheduling(currentCard.created, 'incorrect');

        // Update attempts and handle max attempts case
        let shouldMoveToNext = false;

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

            // Only move to next card if there is one
            if (review.currentCardIndex + 1 < review.dueCards.length) {
                review.moveToNextCard();
            }

            sendFunctionCallOutput(item.call_id, 'skip', 'Moving to next card after maximum attempts');
        } else {
            // Just acknowledge the incorrect attempt
            sendDataChannelMessage({
                type: 'conversation.item.create',
                item: {
                    type: 'function_call_output',
                    call_id: item.call_id,
                    output: JSON.stringify({
                        result: args.result,
                        message: args.message
                    })
                }
            });

            requestNextResponse();
        }
    };

    const getInitialSessionConfig = useCallback(() => {
        return {
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
        };
    }, [currentCard]);

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
                setupAudioVisualization(e.streams[0], true);
            };

            // Add local audio track
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            pc.addTrack(stream.getTracks()[0], stream);

            // Initialize visualization
            setupAudioVisualization(stream, false);

            // Set up data channel
            const dc = pc.createDataChannel("oai-events");
            dataChannelRef.current = dc;

            dc.onopen = () => {
                setIsConnected(true);
                setFeedback('Click the microphone to begin');

                // Set up initial session configuration with function calling
                sendDataChannelMessage(getInitialSessionConfig());

                // Start with a welcome message and introduce the first card
                sendDataChannelMessage({
                    type: 'response.create',
                    response: {
                        instructions: `Give a brief, friendly welcome and explain that you'll help them practice pronunciation and translation. Explain that you'll say a phrase, and they should respond with the correct translation. After the welcome, say "Let's start with our first card" and then clearly say: "${currentCard.frontText}" and wait for the user to respond with the translation.`
                    }
                });

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
    }, [currentCard, sendDataChannelMessage]);

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

                            // Only move to next card if there is one
                            if (review.currentCardIndex + 1 < review.dueCards.length) {
                                review.moveToNextCard();
                            }

                            sendFunctionCallOutput(item.call_id, args.result, args.message);

                        } else if (args.result === 'incorrect') {
                            handleIncorrectResponse(item, args);
                        } else if (args.result === 'quit' || args.result === 'skip') {
                            setShowSkip(true);
                            setTimeout(() => setShowSkip(false), 500);
                            // Mark as incorrect and move to next card
                            review.updateCardScheduling(currentCard.created, 'incorrect');
                            review.setShowAnswer(true);

                            // Only move to next card if there is one
                            if (review.currentCardIndex + 1 < review.dueCards.length) {
                                review.moveToNextCard();
                            }

                            sendFunctionCallOutput(item.call_id, args.result, args.message);
                        }
                    } else if (item.name === 'completeReview') {
                        const args = JSON.parse(item.arguments);
                        setFeedback(args.message);

                        // Send function result back first
                        console.log('Sending function_call_output for completeReview - Finishing review session');
                        sendDataChannelMessage({
                            type: 'conversation.item.create',
                            item: {
                                type: 'function_call_output',
                                call_id: item.call_id,
                                output: JSON.stringify({ success: true })
                            }
                        });

                        requestNextResponse();

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
                        sendDataChannelMessage({
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
                        });

                        requestNextResponse();
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

    // Set up audio visualization first
    const setupAudioVisualization = useCallback((stream, isAiOutput = false) => {
        console.log(`Setting up ${isAiOutput ? 'AI' : 'user'} audio visualization`);
        if (!audioContextRef.current) {
            audioContextRef.current = new AudioContext();
            console.log('Created new AudioContext');
        }

        // Create or get the appropriate analyser
        const analyser = isAiOutput ? aiAnalyserRef : analyserRef;
        if (!analyser.current) {
            analyser.current = audioContextRef.current.createAnalyser();
            analyser.current.fftSize = 256;
            console.log(`Created new AnalyserNode for ${isAiOutput ? 'AI' : 'user'} with fftSize:`, analyser.current.fftSize);
        }

        // Create new source for visualization
        const source = audioContextRef.current.createMediaStreamSource(stream);
        source.connect(analyser.current);
        console.log(`Connected ${isAiOutput ? 'AI' : 'user'} audio source to analyser`);

        // Set up canvas
        const canvas = isAiOutput ? aiCanvasRef.current : canvasRef.current;
        if (!canvas) {
            console.error(`${isAiOutput ? 'AI' : 'User'} canvas element not found`);
            return;
        }

        // Set actual pixel dimensions
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;

        const ctx = canvas.getContext('2d');
        if (isAiOutput) {
            aiCanvasCtxRef.current = ctx;
        } else {
            canvasCtxRef.current = ctx;
        }
        ctx.scale(dpr, dpr);

        const bufferLength = analyser.current.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const WIDTH = rect.width;
        const HEIGHT = rect.height;
        const barWidth = (WIDTH / bufferLength) * 2.5;
        const barSpacing = 2;

        let frameCount = 0;
        const renderFrame = () => {
            if (!analyser.current || !ctx) {
                console.error(`Missing ${isAiOutput ? 'AI' : 'user'} analyser or canvas context`);
                return;
            }

            analyser.current.getByteFrequencyData(dataArray);

            // Calculate average for visualization
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

            // Only update scale if there's actual sound and it's user audio
            if (hasSound && !isAiOutput) {
                setAudioScale(volume * 100);
            }

            // Draw bar visualization
            ctx.clearRect(0, 0, WIDTH, HEIGHT);

            let x = 0;
            for (let i = 0; i < bufferLength; i++) {
                const barHeight = (dataArray[i] / 255.0) * HEIGHT * 0.8;

                // Set color based on state and sound detection
                if (hasSound) {
                    if (!isAiOutput && isRecording) {
                        // Rainbow gradient for user recording
                        const hue = (i / bufferLength) * 360;
                        const lightness = 50 + (barHeight / HEIGHT) * 50;
                        ctx.fillStyle = `hsl(${hue}, 100%, ${lightness}%)`;
                    } else if (isAiOutput && isSpeaking) {
                        // Flame orange for AI speaking
                        const intensity = barHeight / HEIGHT;
                        ctx.fillStyle = `rgba(255, 107, 53, ${0.5 + intensity * 0.5})`;
                    } else {
                        // Default colors
                        const intensity = barHeight / HEIGHT;
                        ctx.fillStyle = isAiOutput
                            ? `rgba(255, 107, 53, ${0.3 + intensity * 0.3})` // AI color
                            : `rgba(100, 149, 237, ${0.3 + intensity * 0.3})`; // User color
                    }
                } else {
                    // Very dim color when no sound
                    ctx.fillStyle = `rgba(100, 100, 100, 0.1)`;
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

            // Store animation frame reference in appropriate ref
            if (isAiOutput) {
                aiAnimationFrameRef.current = requestAnimationFrame(renderFrame);
            } else {
                animationFrameRef.current = requestAnimationFrame(renderFrame);
            }
        };

        renderFrame();

        return () => {
            if (isAiOutput && aiAnimationFrameRef.current) {
                cancelAnimationFrame(aiAnimationFrameRef.current);
            } else if (!isAiOutput && animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            source.disconnect();
        };
    }, [isRecording, isSpeaking]);

    // Update the WebRTC setup to handle AI audio visualization
    useEffect(() => {
        if (mediaStreamRef.current) {
            setupAudioVisualization(mediaStreamRef.current, false);
        }
    }, [setupAudioVisualization]);

    // Remove the mount effect since we'll initialize in setupWebRTC
    useEffect(() => {
        console.log('Mount effect - mediaStream:', !!mediaStreamRef.current);
        if (mediaStreamRef.current) {
            setupAudioVisualization(mediaStreamRef.current, false);
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
        if (!isConnected || isSpeaking) {  // Add isSpeaking check
            setFeedback(isSpeaking ? 'Please wait for AI to finish speaking...' : 'Not connected. Please wait...');
            return;
        }

        setIsRecording(true);
        setFeedback('Listening...');

        // Ensure microphone is enabled
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = true;
            });
            setupAudioVisualization(mediaStreamRef.current, false);
        }

        // Clear any existing audio buffer
        if (dataChannelRef.current) {
            sendDataChannelMessage({
                type: 'input_audio_buffer.clear'
            });
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

            // Commit the audio buffer
            sendDataChannelMessage({
                type: 'input_audio_buffer.commit'
            });

            requestNextResponse();

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
            stopRecording();
        } else {
            startRecording();
        }
    };

    return (
        <div className="voice-mode">
            <div className="voice-interface">
                <div className="visualization-container">
                    <div className="visualizer user">
                        <canvas ref={canvasRef} className="audio-canvas" />
                    </div>
                    <div className="visualizer ai">
                        <canvas ref={aiCanvasRef} className="audio-canvas" />
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