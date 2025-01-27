import { getRealtimeToken } from '../../network/api';
import { setupRealtimeStream } from '../../network/openai';
import { configureSession } from './sessionTools';

export const setupWebRTC = async ({
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
}) => {
    try {
        console.log('Starting WebRTC setup...');
        const EPHEMERAL_KEY = await getRealtimeToken();
        console.log('Got ephemeral token:', EPHEMERAL_KEY);

        console.log('Creating RTCPeerConnection...');
        const pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });
        peerConnectionRef.current = pc;

        console.log('Setting up audio element...');
        audioElementRef.current = new Audio();
        audioElementRef.current.autoplay = true;
        pc.ontrack = e => {
            console.log('Received remote track:', e.streams[0]);
            audioElementRef.current.srcObject = e.streams[0];
        };

        console.log('Requesting user media...');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('Got user media stream:', stream);
        mediaStreamRef.current = stream;
        pc.addTrack(stream.getTracks()[0], stream);

        console.log('Creating data channel...');
        const dc = pc.createDataChannel("oai-events", {
            ordered: true
        });
        dataChannelRef.current = dc;

        dc.onopen = () => {
            console.log('Data channel opened');
            setIsConnected(true);
            setFeedback('Click the microphone to begin');
            console.log('Configuring session with card:', card);
            try {
                configureSession(dc, card, sessionTools);
            } catch (error) {
                console.error('Error configuring session:', error);
                setFeedback('Failed to configure session: ' + error.message);
            }
        };

        dc.onclose = () => {
            console.log('Data channel closed');
            setIsConnected(false);
            setFeedback('Connection lost');
        };

        dc.onerror = (error) => {
            console.error('Data channel error:', error);
            setFeedback('Connection error: ' + error.message);
        };

        dc.onmessage = (e) => {
            try {
                const event = JSON.parse(e.data);
                console.log('Received message:', event);
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
                handleRealtimeEvent(event, review, card);
            } catch (error) {
                console.error('Error handling message:', error);
            }
        };

        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            console.log('ICE connection state changed:', state);
            if (state === 'failed' || state === 'disconnected') {
                console.error('ICE connection failed or disconnected');
                setFeedback('Connection lost - ' + state);
            } else if (state === 'connected') {
                console.log('ICE connection established');
            }
        };

        pc.onicecandidate = (event) => {
            console.log('ICE candidate:', event.candidate);
        };

        pc.onicegatheringstatechange = () => {
            console.log('ICE gathering state:', pc.iceGatheringState);
        };

        pc.onsignalingstatechange = () => {
            console.log('Signaling state:', pc.signalingState);
        };

        console.log('Creating offer...');
        const offer = await pc.createOffer();
        console.log('Setting local description:', offer);
        await pc.setLocalDescription(offer);
        console.log('Getting remote description...');
        const answer = await setupRealtimeStream(offer, EPHEMERAL_KEY);
        console.log('Setting remote description:', answer);
        await pc.setRemoteDescription(answer);

        console.log('WebRTC setup completed successfully');
        return true;
    } catch (error) {
        console.error('Error setting up WebRTC:', error);
        setFeedback('Failed to connect: ' + error.message);
        setIsConnected(false);
        return false;
    }
};

export const cleanup = ({
    mediaStreamRef,
    peerConnectionRef,
    audioElementRef,
    audioContextRef,
    animationFrameRef,
    aiAnimationFrameRef
}) => {
    console.log('Starting cleanup...');
    if (mediaStreamRef.current) {
        console.log('Stopping media tracks...');
        mediaStreamRef.current.getTracks().forEach(track => track.stop());
    }
    if (peerConnectionRef.current) {
        console.log('Closing peer connection...');
        peerConnectionRef.current.close();
    }
    if (audioElementRef.current) {
        console.log('Cleaning up audio element...');
        audioElementRef.current.srcObject = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
        console.log('Closing audio context...');
        audioContextRef.current.close();
    }
    if (animationFrameRef.current) {
        console.log('Canceling animation frames...');
        cancelAnimationFrame(animationFrameRef.current);
    }
    if (aiAnimationFrameRef.current) {
        cancelAnimationFrame(aiAnimationFrameRef.current);
    }
    if (window.speakingTimeoutId) {
        clearTimeout(window.speakingTimeoutId);
    }
    console.log('Cleanup completed');
}; 