import React, { createContext, useContext, useState, useRef } from 'react';
import { getRealtimeToken } from '../network/api';
import { configureSession } from './realtime/sessionTools';
import { setupRealtimeStream } from '../network/openai';
import { useReview } from './ReviewContext';
import { useDecks } from './DeckContext';

const RealtimeContext = createContext(null);

export const RealtimeProvider = ({ children }) => {
    const [showSkip, setShowSkip] = useState(false);
    const [isConnected, setIsConnected] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [hasActiveResponse, setHasActiveResponse] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [feedback, setFeedback] = useState('Click microphone to start');
    const [buttonState, setButtonState] = useState('default');
    const [audioScale, setAudioScale] = useState(0);

    // WebRTC refs
    const peerConnectionRef = useRef(null);
    const dataChannelRef = useRef(null);
    const mediaStreamRef = useRef(null);

    // Audio refs
    const audioElementRef = useRef(null);
    const audioContextRef = useRef(null);
    const animationFrameRef = useRef(null);
    const aiAnimationFrameRef = useRef(null);

    const {
        markCorrectGetNext,
        markIncorrectGetAttempts,
        cardSchedulerRef,
        currentCardIdRef
    } = useReview();

    // Get deck information from DeckContext
    const { decks, currentDeckId } = useDecks();

    const sendFunctionOutput = (callId, output) => {
        if (!dataChannelRef.current) return;
        console.log('sendFunctionOutput ' + JSON.stringify(output));
        dataChannelRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify(output)
            }
        }));
    };

    const sendNextCardInfo = (nextCard, isLastCard, callId, result = 'correct', message = '') => {
        if (!dataChannelRef.current) return;
        console.log('sendNextCardInfo ' + JSON.stringify({
            result,
            message,
            nextCard: nextCard ? {
                front_text: nextCard.front_text,
                back_text: nextCard.back_text
            } : null,
            isLastCard
        }));
        dataChannelRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({
                    result,
                    message,
                    nextCard: nextCard ? {
                        front_text: nextCard.front_text,
                        back_text: nextCard.back_text
                    } : null,
                    hasMoreCards: !isLastCard
                })
            }
        }));
    };

    const sendCompleteReview = (callId) => {
        if (!dataChannelRef.current) return;
        dataChannelRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({
                    message: 'Great job! You have completed all your cards for now. Keep up the good work!'
                })
            }
        }));
    };

    const requestNextResponse = () => {
        if (!dataChannelRef.current || hasActiveResponse) return;
        dataChannelRef.current.send(JSON.stringify({
            type: 'response.create'
        }));
    };


    const handleAudioStarted = () => {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = false;
            });
        }
    };

    const handleAudioStopped = () => {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = true;
            });
        }

        if (cardSchedulerRef.current.peekNext() == null) {
            if (mediaStreamRef.current) {
                mediaStreamRef.current.getTracks().forEach(track => track.stop());
            }
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
        }
    };

    const handleTextDelta = ({ event }) => {
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
    };


    const handleIncorrectResponse = ({
        args,
        callId,
    }) => {
        setButtonState('error');
        setTimeout(() => setButtonState('default'), 500);

        // Get results from ReviewContext
        const { attempts, nextCard } = markIncorrectGetAttempts();
        
        if (nextCard) {
            sendNextCardInfo(nextCard, false, callId, args.result, args.message);
        } else {
            cleanup();
        }

        /*sendFunctionOutput(callId, {
            nextCard: nextCard ? {
                front_text: nextCard.front_text,
                back_text: nextCard.back_text
            } : null
        });*/

        requestNextResponse();
    };

    const handleCompleteReviewFunction = ({ args, callId }) => {
        setFeedback(args.message);
        sendFunctionOutput(callId, { success: true });
        requestNextResponse();
    };

    const handleCorrectResponse = async ({ args, callId }) => {
        setButtonState('success');
        setTimeout(() => setButtonState('default'), 500);

        // Process in ReviewContext - this will now use the ref-based tracking to prevent double processing
        const nextCard = await markCorrectGetNext();
        
        if (nextCard) {
            sendNextCardInfo(nextCard, false, callId, args.result, args.message);
        } else {
            sendCompleteReview(callId);
            cleanup();
        }

        requestNextResponse();
    };

    const handleRealtimeEvent = (event) => {
        switch (event.type) {
            case 'output_audio_buffer.started':
                handleAudioStarted();
                break;
            case 'output_audio_buffer.stopped':
                handleAudioStopped();
                break;
            case 'response.text.delta':
                handleTextDelta({ event });
                break;
            case 'response.output_item.done':
                if (event.item.type === 'function_call') {
                    handleFunctionCall(event.item);
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
                break;
        }
    };

    const handleFunctionCall = (item) => {
        const args = JSON.parse(item.arguments);
        console.log('handleFunctionCall ' + JSON.stringify(args));

        if (item.name === 'evaluatePronunciation') {
            setFeedback(args.message);
            switch (args.result) {
                case 'correct':
                    handleCorrectResponse({
                        args,
                        callId: item.call_id,
                    });
                    break;
                case 'incorrect':
                    handleIncorrectResponse({
                        args,
                        callId: item.call_id,
                    });
                    break;
                default: 
                    break;
            }
        } else if (item.name === 'completeReview') {
            handleCompleteReviewFunction({
                args,
                callId: item.call_id,
            });
        }
    };

    const cleanup = () => {
        // Clean up media stream
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => {
                track.enabled = false;
                track.stop();
            });
            mediaStreamRef.current = null;
        }

        // Clean up peer connection
        if (peerConnectionRef.current) {

            try {
                // Close all data channels
                const channels = peerConnectionRef.current.getDataChannels?.() || [];
                channels.forEach(channel => {
                    channel.close();
                });

                // Close all transceivers
                const transceivers = peerConnectionRef.current.getTransceivers?.() || [];
                transceivers.forEach(transceiver => {
                    try {
                        transceiver.stop();
                    } catch (e) {
                        console.warn('Error stopping transceiver:', e);
                    }
                });

                // Close the peer connection
                peerConnectionRef.current.close();
            } catch (e) {
                console.warn('Error during peer connection cleanup:', e);
            }
            peerConnectionRef.current = null;
        }

        // Clean up audio element
        if (audioElementRef.current) {
            const srcObject = audioElementRef.current.srcObject;
            if (srcObject instanceof MediaStream) {
                srcObject.getTracks().forEach(track => {
                    track.stop();
                });
            }
            audioElementRef.current.pause();
            audioElementRef.current.srcObject = null;
            audioElementRef.current = null;
        }

        // Clean up audio context
        if (audioContextRef.current) {

            if (audioContextRef.current.state !== 'closed') {
                try {
                    // Disconnect all nodes
                    const destination = audioContextRef.current.destination;
                    if (destination) {
                        const maxChannelCount = destination.maxChannelCount;
                        destination.channelCount = maxChannelCount;
                        destination.disconnect();
                    }

                    // Close the context
                    audioContextRef.current.close().then(() => {
                    }).catch(e => {
                        console.warn('Error closing AudioContext:', e);
                    });
                } catch (e) {
                    console.warn('Error during audio context cleanup:', e);
                }
            }
            audioContextRef.current = null;
        }

        // Clean up animation frames
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        if (aiAnimationFrameRef.current) {
            cancelAnimationFrame(aiAnimationFrameRef.current);
            aiAnimationFrameRef.current = null;
        }

        // Clear any pending timeouts
        if (window.speakingTimeoutId) {
            clearTimeout(window.speakingTimeoutId);
            window.speakingTimeoutId = null;
        }

    };

    const setupWebRTC = async () => {
        // Get most current card ID and related values
        const card = cardSchedulerRef.current.getFullCard(currentCardIdRef.current);
        
        try {
            const EPHEMERAL_KEY = await getRealtimeToken();

            const pc = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' }
                ]
            });
            peerConnectionRef.current = pc;

            audioElementRef.current = new Audio();
            audioElementRef.current.autoplay = true;
            pc.ontrack = e => {
                audioElementRef.current.srcObject = e.streams[0];
            };

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            pc.addTrack(stream.getTracks()[0], stream);

            const dc = pc.createDataChannel("oai-events", {
                ordered: true
            });
            dataChannelRef.current = dc;

            dc.onopen = () => {
                setIsConnected(true);
                setFeedback('Click the microphone to begin');
                // Get the current deck to access language information
                const currentDeck = decks[currentDeckId];
                configureSession(dc, card, currentDeck.learning_language);
            };

            dc.onclose = () => {
                setIsConnected(false);
                setFeedback('Connection lost');
            };

            dc.onerror = (error) => {
                setFeedback('Connection error: ' + error.message);
            };

            dc.onmessage = (e) => {
                try {
                    const event = JSON.parse(e.data);
                    if (event.type === 'response.text.delta') {
                        setIsSpeaking(true);
                        setHasActiveResponse(true);
                        if (window.speakingTimeoutId) {
                            clearTimeout(window.speakingTimeoutId);
                        }
                        window.speakingTimeoutId = setTimeout(() => {
                            setIsSpeaking(false);
                        }, 500);
                    }
                    handleRealtimeEvent(event);
                } catch (error) {
                    console.error('Error handling message:', error);
                }
            };

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                if (state === 'failed' || state === 'disconnected') {
                    setFeedback('Connection lost - ' + state);
                } else if (state === 'connected') {
                }
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const answer = await setupRealtimeStream(offer, EPHEMERAL_KEY);
            await pc.setRemoteDescription(answer);

            return true;
        } catch (error) {
            console.error('Error setting up WebRTC:', error);
            setFeedback('Failed to connect: ' + error.message);
            setIsConnected(false);
            return false;
        }
    };

    return (
        <RealtimeContext.Provider value={{
            isConnected,
            isSpeaking,
            isRecording,
            hasActiveResponse,
            feedback,
            buttonState,
            audioScale,
            showSkip,
            mediaStreamRef,
            audioElementRef,
            audioContextRef,
            animationFrameRef,
            aiAnimationFrameRef,
            setupWebRTC,
            cleanup,
            setIsRecording,
            setAudioScale,
            setFeedback,
            setIsConnected,
            peerConnectionRef
        }}>
            {children}
        </RealtimeContext.Provider>
    );
};

export const useRealtime = () => {
    const context = useContext(RealtimeContext);
    if (!context) {
        throw new Error('useRealtime must be used within a RealtimeProvider');
    }
    return context;
}; 