import { useState, useRef, useCallback } from 'react';

export const useRealtimeAPI = ({ onEvent, onFeedback, onConnectionChange }) => {
    const [isConnected, setIsConnected] = useState(false);
    const [isConnecting, setIsConnecting] = useState(false);
    const [hasActiveResponse, setHasActiveResponse] = useState(false);
    const peerConnectionRef = useRef(null);
    const dataChannelRef = useRef(null);
    const audioElementRef = useRef(null);
    const mediaStreamRef = useRef(null);

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

    const setupWebRTC = useCallback(async (initialSessionConfig) => {
        try {
            setIsConnecting(true);
            onFeedback('Connecting...');

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
                onEvent('track', e.streams[0]);
            };

            // Add local audio track
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaStreamRef.current = stream;
            pc.addTrack(stream.getTracks()[0], stream);
            onEvent('localStream', stream);

            // Set up data channel
            const dc = pc.createDataChannel("oai-events");
            dataChannelRef.current = dc;

            dc.onopen = () => {
                setIsConnected(true);
                onConnectionChange(true);
                onFeedback('Click the microphone to begin');

                // Set up initial session configuration
                sendDataChannelMessage(initialSessionConfig);

                // Start with a welcome message
                sendDataChannelMessage({
                    type: 'response.create',
                    response: {
                        instructions: initialSessionConfig.session.instructions
                    }
                });
            };

            dc.onclose = () => {
                setIsConnected(false);
                onConnectionChange(false);
                onFeedback('Connection lost');
            };

            dc.onmessage = (e) => {
                const event = JSON.parse(e.data);
                onEvent('message', event);
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
            setIsConnecting(false);

        } catch (error) {
            console.error('Error setting up WebRTC:', error);
            onFeedback('Failed to connect: ' + error.message);
            setIsConnected(false);
            setIsConnecting(false);
            onConnectionChange(false);
        }
    }, [onEvent, onFeedback, onConnectionChange]);

    const startRecording = useCallback(() => {
        if (!isConnected) {
            onFeedback('Not connected. Please wait...');
            return;
        }

        // Ensure microphone is enabled
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach(track => {
                track.enabled = true;
            });
        }

        // Clear any existing audio buffer
        if (dataChannelRef.current) {
            sendDataChannelMessage({
                type: 'input_audio_buffer.clear'
            });
        }
    }, [isConnected, onFeedback]);

    const stopRecording = useCallback(() => {
        if (dataChannelRef.current) {
            // Commit the audio buffer
            sendDataChannelMessage({
                type: 'input_audio_buffer.commit'
            });

            requestNextResponse();
            onFeedback('Processing...');
        }
    }, [requestNextResponse, onFeedback]);

    const cleanup = useCallback(() => {
        if (mediaStreamRef.current) {
            mediaStreamRef.current.getTracks().forEach(track => track.stop());
        }
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
        }
        if (audioElementRef.current) {
            audioElementRef.current.srcObject = null;
        }
    }, []);

    return {
        isConnected,
        isConnecting,
        hasActiveResponse,
        setHasActiveResponse,
        setupWebRTC,
        startRecording,
        stopRecording,
        cleanup,
        sendDataChannelMessage,
        requestNextResponse,
        mediaStream: mediaStreamRef.current
    };
}; 