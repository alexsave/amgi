import React, { createContext, useContext, useState, useRef } from 'react';
import { setupWebRTC, cleanup } from './realtime/webrtc';
import { createRealtimeTools } from './realtime/realtimeTools';
import * as eventHandlers from './realtime/eventHandlers';

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

    const handleRealtimeEvent = (event, reviewCallbacks, card, onAudioStopped) => {
        switch (event.type) {
            case 'output_audio_buffer.started':
                eventHandlers.handleAudioStarted({ mediaStreamRef });
                break;
            case 'output_audio_buffer.stopped':
                eventHandlers.handleAudioStopped({
                    mediaStreamRef,
                    onAudioStopped
                });
                break;
            case 'response.text.delta':
                eventHandlers.handleTextDelta({
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
                    handleFunctionCall(event.item, reviewCallbacks, card);
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

    const handleFunctionCall = (item, reviewCallbacks, card) => {
        console.log('Received function call:', { name: item.name, arguments: JSON.parse(item.arguments) }, '- Processing user response and updating UI accordingly');
        const args = JSON.parse(item.arguments);

        if (item.name === 'evaluatePronunciation') {
            setFeedback(args.message);
            switch (args.result) {
                case 'correct':
                    eventHandlers.handleCorrectResponse({
                        args,
                        callId: item.call_id,
                        markCorrectGetNext: reviewCallbacks.markCorrectGetNext,
                        setButtonState,
                        realtimeTools
                    });
                    break;
                case 'incorrect':
                    eventHandlers.handleIncorrectResponse({
                        args,
                        callId: item.call_id,
                        markIncorrectGetAttempts: reviewCallbacks.markIncorrectGetAttempts,
                        setButtonState,
                        realtimeTools,
                    });
                    break;
                case 'quit':
                case 'skip':
                    eventHandlers.handleSkipResponse({
                        args,
                        callId: item.call_id,
                        currentCardId: reviewCallbacks.currentCardId,
                        dueCards: reviewCallbacks.dueCards,
                        updateCardScheduling: reviewCallbacks.updateCardScheduling,
                        setShowAnswer: reviewCallbacks.setShowAnswer,
                        setShowSkip,
                        realtimeTools
                    });
                    break;
                case 'again':
                    eventHandlers.handleAgainResponse({
                        args,
                        callId: item.call_id,
                        realtimeTools
                    });
                    break;
            }
        } else if (item.name === 'completeReview') {
            eventHandlers.handleCompleteReviewFunction({
                args,
                callId: item.call_id,
                setFeedback,
                realtimeTools
            });
        } else if (item.name === 'getNextCard') {
            eventHandlers.handleGetNextCard({
                callId: item.call_id,
                currentCardId: reviewCallbacks.currentCardId,
                dueCards: reviewCallbacks.dueCards,
                realtimeTools
            });
        }
    };

    const setupWebRTCWrapper = async (card, reviewCallbacks, onAudioStopped) => {
        return setupWebRTC({
            card,
            ...reviewCallbacks,
            onAudioStopped,
            setIsConnected,
            setFeedback,
            setIsSpeaking,
            setHasActiveResponse,
            peerConnectionRef,
            dataChannelRef,
            mediaStreamRef,
            audioElementRef,
            handleRealtimeEvent,
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