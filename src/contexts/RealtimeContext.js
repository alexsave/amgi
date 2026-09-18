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
    const [isRecording, setIsRecordingState] = useState(false);
    const [feedback, setFeedback] = useState('Click microphone to start');
    const [buttonState, setButtonState] = useState('default');

    // The visualizers render from these, so they have to be state: a ref would
    // hand them whatever was there on the first render and never update.
    const [micStream, setMicStream] = useState(null);
    const [remoteStream, setRemoteStream] = useState(null);

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

    // The data channel handlers are bound once at connection time, so any
    // state they need to READ must live in refs - a closure over useState
    // values would be permanently stale.
    const isRecordingRef = useRef(false);
    const responseActiveRef = useRef(false);
    const responsePendingRef = useRef(false);

    const {
        markCorrectGetNext,
        markIncorrectGetNext,
        cardSchedulerRef,
        currentCardIdRef
    } = useReview();

    const { decks, currentDeckId } = useDecks();

    // Keeps the state (for rendering) and the ref (for the event handlers)
    // in sync, and mutes/unmutes the actual mic tracks to match.
    const setIsRecording = (recording) => {
        isRecordingRef.current = recording;
        setIsRecordingState(recording);
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = recording;
            });
        }
    };

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

    const sendNextCardInfo = (nextCard, callId, result = 'correct', message = '') => {
        sendFunctionOutput(callId, {
            result,
            message,
            nextCard: nextCard ? {
                front_text: nextCard.front_text,
                back_text: nextCard.back_text
            } : null,
            hasMoreCards: !!nextCard
        });
    };

    const sendCompleteReview = (callId) => {
        sendFunctionOutput(callId, {
            message: 'Great job! You have completed all your cards for now. Keep up the good work!'
        });
    };

    /**
     * Asks the model to speak its next turn. Function-call outputs arrive
     * while the tool-call response is still open (`response.output_item.done`
     * fires before `response.done`), so creating a response immediately would
     * be rejected with "conversation already has an active response" - queue
     * it and flush on `response.done` instead.
     */
    const requestNextResponse = () => {
        if (!dataChannelRef.current) return;
        if (responseActiveRef.current) {
            responsePendingRef.current = true;
            return;
        }
        responseActiveRef.current = true;
        dataChannelRef.current.send(JSON.stringify({ type: 'response.create' }));
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
        // Restore the mic only to the state the user chose.
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = isRecordingRef.current;
            });
        }

        if (cardSchedulerRef.current.peekNext() == null) {
            cleanup();
        }
    };

    const handleTranscriptDelta = (event) => {
        setIsSpeaking(true);
        setFeedback(prev => prev + event.delta);
        // Stop the recording indicator while the AI is talking
        if (isRecordingRef.current) {
            setIsRecording(false);
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        }
        // Mark speaking as done if no new delta arrives for a moment
        if (speakingTimeoutRef.current) {
            clearTimeout(speakingTimeoutRef.current);
        }
        speakingTimeoutRef.current = setTimeout(() => {
            setIsSpeaking(false);
        }, 500);
    };

    // Shared handler for both verdicts: flash the button, advance the
    // scheduler, answer the model's pending function call, and queue the
    // next spoken turn.
    const handleEvaluation = (args, callId) => {
        const correct = args.result === 'correct';
        setButtonState(correct ? 'success' : 'error');
        setTimeout(() => setButtonState('default'), 500);

        const nextCard = correct ? markCorrectGetNext() : markIncorrectGetNext();

        if (nextCard) {
            sendNextCardInfo(nextCard, callId, args.result, args.message);
        } else {
            // Always answer the pending function call - tearing down without
            // a reply leaves the model hanging mid-conversation. The session
            // winds down in handleAudioStopped once the goodbye finishes.
            sendCompleteReview(callId);
        }

        requestNextResponse();
    };

    const handleCompleteReviewFunction = ({ args, callId }) => {
        setFeedback(args.message);
        sendFunctionOutput(callId, { success: true });
    };

    const handleFunctionCall = (item) => {
        const args = JSON.parse(item.arguments);

        if (item.name === 'evaluatePronunciation') {
            setFeedback(args.message);
            handleEvaluation(args, item.call_id);
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
            case 'response.output_audio_transcript.delta':
            case 'response.output_text.delta':
                handleTranscriptDelta(event);
                break;
            case 'response.output_item.done':
                if (event.item.type === 'function_call') {
                    handleFunctionCall(event.item);
                }
                break;
            case 'response.created':
                responseActiveRef.current = true;
                // New response incoming - reset the transcript display.
                setFeedback('');
                break;
            case 'response.done':
                responseActiveRef.current = false;
                setIsSpeaking(false);
                // Flush a turn that was requested while this response was open.
                if (responsePendingRef.current) {
                    responsePendingRef.current = false;
                    requestNextResponse();
                }
                break;
            case 'error':
                console.error('realtime api error:', event.error);
                setFeedback('error: ' + event.error.message);
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
        setMicStream(null);
        setRemoteStream(null);

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

        responseActiveRef.current = false;
        responsePendingRef.current = false;
        isRecordingRef.current = false;
        setIsConnected(false);
        setIsRecordingState(false);
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
            // Ask for the microphone BEFORE minting the token: a denied
            // permission prompt must not consume a realtime-session credit.
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            setMicStream(stream);

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
                setRemoteStream(e.streams[0]);
            };

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
                responseActiveRef.current = true; // configureSession sends response.create
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
            cleanup();
            return false;
        }
    };

    return (
        <RealtimeContext.Provider value={{
            isConnected,
            isSpeaking,
            isRecording,
            feedback,
            buttonState,
            mediaStreamRef,
            audioElementRef,
            micStream,
            remoteStream,
            audioContextRef,
            animationFrameRef,
            aiAnimationFrameRef,
            setupWebRTC,
            cleanup,
            setIsRecording,
            setFeedback
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
