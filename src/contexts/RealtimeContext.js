import React, { createContext, useContext, useState, useRef } from 'react';
import { getRealtimeToken } from '../network/supabaseApi';
import { configureSession } from '../realtime/sessionTools';
import { setupRealtimeStream } from '../network/openai';
import { useReview } from './ReviewContext';
import { useDecks } from './DeckContext';

const RealtimeContext = createContext(null);

export const RealtimeProvider = ({ children }) => {
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
    const speakingTimeoutRef = useRef(null);

    const {
        markCorrectGetNext,
        markIncorrectGetNext,
        cardSchedulerRef,
        currentCardIdRef
    } = useReview();

    const { decks, currentDeckId } = useDecks();

    const sendFunctionOutput = (callId, output) => {
        if (!dataChannelRef.current) return;
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
        sendFunctionOutput(callId, {
            result,
            message,
            nextCard: nextCard ? {
                front_text: nextCard.front_text,
                back_text: nextCard.back_text
            } : null,
            hasMoreCards: !isLastCard
        });
    };

    const sendCompleteReview = (callId) => {
        sendFunctionOutput(callId, {
            message: 'Great job! You have completed all your cards for now. Keep up the good work!'
        });
    };

    const requestNextResponse = () => {
        if (!dataChannelRef.current || hasActiveResponse) return;
        dataChannelRef.current.send(JSON.stringify({
            type: 'response.create'
        }));
    };

    // While the model speaks, mute the mic so it doesn't hear itself.
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
            cleanup();
        }
    };

    const handleTranscriptDelta = (event) => {
        setIsSpeaking(true);
        setHasActiveResponse(true);
        setFeedback(prev => prev + event.delta);
        // Stop recording indicator while the AI is talking
        if (isRecording) {
            setIsRecording(false);
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
            setAudioScale(0);
        }
        // Mark speaking as done if no new delta arrives for a moment
        if (speakingTimeoutRef.current) {
            clearTimeout(speakingTimeoutRef.current);
        }
        speakingTimeoutRef.current = setTimeout(() => {
            setIsSpeaking(false);
        }, 500);
    };

    const handleIncorrectResponse = ({ args, callId }) => {
        setButtonState('error');
        setTimeout(() => setButtonState('default'), 500);

        const nextCard = markIncorrectGetNext();

        if (nextCard) {
            sendNextCardInfo(nextCard, false, callId, args.result, args.message);
        } else {
            cleanup();
            return;
        }

        requestNextResponse();
    };

    const handleCorrectResponse = ({ args, callId }) => {
        setButtonState('success');
        setTimeout(() => setButtonState('default'), 500);

        const nextCard = markCorrectGetNext();

        if (nextCard) {
            sendNextCardInfo(nextCard, false, callId, args.result, args.message);
        } else {
            sendCompleteReview(callId);
        }

        requestNextResponse();
    };

    const handleCompleteReviewFunction = ({ args, callId }) => {
        setFeedback(args.message);
        sendFunctionOutput(callId, { success: true });
        requestNextResponse();
    };

    const handleFunctionCall = (item) => {
        const args = JSON.parse(item.arguments);

        if (item.name === 'evaluatePronunciation') {
            setFeedback(args.message);
            if (args.result === 'correct') {
                handleCorrectResponse({ args, callId: item.call_id });
            } else if (args.result === 'incorrect') {
                handleIncorrectResponse({ args, callId: item.call_id });
            }
        } else if (item.name === 'completeReview') {
            handleCompleteReviewFunction({ args, callId: item.call_id });
        }
    };

    const handleRealtimeEvent = (event) => {
        switch (event.type) {
            case 'output_audio_buffer.started':
                handleAudioStarted();
                break;
            case 'output_audio_buffer.stopped':
                handleAudioStopped();
                break;
            // GA event names, with the beta names kept for compatibility.
            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta':
            case 'response.output_text.delta':
            case 'response.text.delta':
                handleTranscriptDelta(event);
                break;
            case 'response.output_item.done':
                if (event.item.type === 'function_call') {
                    handleFunctionCall(event.item);
                }
                break;
            case 'response.created':
                setHasActiveResponse(true);
                // New response incoming — reset the transcript display.
                setFeedback('');
                break;
            case 'response.done':
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

    const cleanup = () => {
        // Clean up media stream
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => {
                track.enabled = false;
                track.stop();
            });
            mediaStreamRef.current = null;
        }

        // Clean up data channel and peer connection
        if (dataChannelRef.current) {
            try {
                dataChannelRef.current.close();
            } catch (e) {
                console.warn('Error closing data channel:', e);
            }
            dataChannelRef.current = null;
        }

        if (peerConnectionRef.current) {
            try {
                const transceivers = peerConnectionRef.current.getTransceivers?.() || [];
                transceivers.forEach(transceiver => {
                    try {
                        transceiver.stop();
                    } catch (e) {
                        // Already stopped
                    }
                });
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
                srcObject.getTracks().forEach(track => track.stop());
            }
            audioElementRef.current.pause();
            audioElementRef.current.srcObject = null;
            audioElementRef.current = null;
        }

        // Clean up audio context
        if (audioContextRef.current) {
            if (audioContextRef.current.state !== 'closed') {
                audioContextRef.current.close().catch(e => {
                    console.warn('Error closing AudioContext:', e);
                });
            }
            audioContextRef.current = null;
        }

        // Clean up animation frames and timers
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
        if (aiAnimationFrameRef.current) {
            cancelAnimationFrame(aiAnimationFrameRef.current);
            aiAnimationFrameRef.current = null;
        }
        if (speakingTimeoutRef.current) {
            clearTimeout(speakingTimeoutRef.current);
            speakingTimeoutRef.current = null;
        }

        setIsConnected(false);
        setIsRecording(false);
        setHasActiveResponse(false);
        setIsSpeaking(false);
    };

    const setupWebRTC = async () => {
        // Get most current card ID and related values
        const card = cardSchedulerRef.current.getFullCard(currentCardIdRef.current);
        if (!card) {
            setFeedback('No cards to review right now.');
            return false;
        }

        try {
            const { client_secret } = await getRealtimeToken();

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
                const currentDeck = decks[currentDeckId];
                configureSession(dc, card, currentDeck?.learning_language, currentDeck?.known_language);
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
                    handleRealtimeEvent(JSON.parse(e.data));
                } catch (error) {
                    console.error('Error handling message:', error);
                }
            };

            pc.oniceconnectionstatechange = () => {
                const state = pc.iceConnectionState;
                if (state === 'failed' || state === 'disconnected') {
                    setFeedback('Connection lost - ' + state);
                }
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            const answer = await setupRealtimeStream(offer, client_secret);
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
