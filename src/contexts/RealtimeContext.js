import React, { createContext, useContext, useState, useRef } from 'react';
import { sessionTools } from './realtime/sessionTools';
import { setupWebRTC, cleanup } from './realtime/webrtc';
import { createRealtimeTools } from './realtime/realtimeTools';
import {
    handleAudioStarted,
    handleAudioStopped,
    handleTextDelta,
    handleCorrectResponse,
    handleIncorrectResponse,
    handleMaxAttempts,
    handleSkipResponse,
    handleAgainResponse,
    handleGetNextCard,
    handleCompleteReviewFunction
} from './realtime/eventHandlers';

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

    const realtimeTools = createRealtimeTools(dataChannelRef);

    const handleRealtimeEvent = (event, review, card) => {
        console.log('Realtime event:', event);
        switch (event.type) {
            case 'output_audio_buffer.audio_started':
                handleAudioStarted({ mediaStreamRef });
                break;
            case 'output_audio_buffer.audio_stopped':
                handleAudioStopped({
                    mediaStreamRef,
                    peerConnectionRef,
                    setIsConnected,
                    hasActiveResponse,
                    review
                });
                break;
            case 'response.text.delta':
                handleTextDelta({
                    event,
                    setIsSpeaking,
                    setHasActiveResponse,
                    setFeedback,
                    isRecording,
                    setIsRecording,
                    animationFrameRef,
                    setAudioScale
                });
                break;
            case 'response.output_item.done':
                if (event.item.type === 'function_call') {
                    handleFunctionCall(event.item, review, card);
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

    const handleFunctionCall = (item, review, card) => {
        console.log('Received function call:', { name: item.name, arguments: JSON.parse(item.arguments) }, '- Processing user response and updating UI accordingly');
        const args = JSON.parse(item.arguments);

        if (item.name === 'evaluatePronunciation') {
            setFeedback(args.message);
            switch (args.result) {
                case 'correct':
                    handleCorrectResponse({
                        args,
                        callId: item.call_id,
                        review,
                        currentCard: card,
                        setButtonState,
                        realtimeTools
                    });
                    break;
                case 'incorrect':
                    handleIncorrectResponse({
                        args,
                        callId: item.call_id,
                        review,
                        currentCard: card,
                        setButtonState,
                        realtimeTools,
                        handleMaxAttempts: (callId, review) => handleMaxAttempts({
                            callId,
                            review,
                            realtimeTools
                        })
                    });
                    break;
                case 'quit':
                case 'skip':
                    handleSkipResponse({
                        args,
                        callId: item.call_id,
                        review,
                        currentCard: card,
                        setShowSkip,
                        realtimeTools
                    });
                    break;
                case 'again':
                    handleAgainResponse({
                        args,
                        callId: item.call_id,
                        realtimeTools
                    });
                    break;
            }
        } else if (item.name === 'completeReview') {
            handleCompleteReviewFunction({
                args,
                callId: item.call_id,
                setFeedback,
                realtimeTools
            });
        } else if (item.name === 'getNextCard') {
            handleGetNextCard({
                callId: item.call_id,
                review,
                realtimeTools
            });
        }
    };

    const setupWebRTCWrapper = async (card, review) => {
        return setupWebRTC({
            card,
            review,
            setIsConnected,
            setFeedback,
            setIsSpeaking,
            setHasActiveResponse,
            peerConnectionRef,
            dataChannelRef,
            mediaStreamRef,
            audioElementRef,
            handleRealtimeEvent,
            sessionTools
        });
    };

    const cleanupWrapper = () => {
        cleanup({
            mediaStreamRef,
            peerConnectionRef,
            audioElementRef,
            audioContextRef,
            animationFrameRef,
            aiAnimationFrameRef
        });
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
            setupWebRTC: setupWebRTCWrapper,
            cleanup: cleanupWrapper,
            setIsRecording,
            setAudioScale,
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