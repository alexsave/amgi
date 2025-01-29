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
            //console.log('ICE candidate:', event.candidate);
        };

        pc.onicegatheringstatechange = () => {
            //console.log('ICE gathering state:', pc.iceGatheringState);
        };

        pc.onsignalingstatechange = () => {
            //console.log('Signaling state:', pc.signalingState);
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
    console.log('Starting cleanup of WebRTC and audio resources...');
    
    // Clean up media stream
    if (mediaStreamRef.current) {
        console.log('Stopping media tracks...', {
            tracks: mediaStreamRef.current.getTracks().map(track => ({
                id: track.id,
                kind: track.kind,
                enabled: track.enabled,
                readyState: track.readyState,
                muted: track.muted
            }))
        });
        mediaStreamRef.current.getTracks().forEach(track => {
            track.enabled = false;
            track.stop();
            console.log(`Stopped track ${track.id}:`, {
                enabled: track.enabled,
                readyState: track.readyState,
                muted: track.muted
            });
        });
        mediaStreamRef.current = null;
    }

    // Clean up peer connection
    if (peerConnectionRef.current) {
        console.log('Closing peer connection...', {
            signalingState: peerConnectionRef.current.signalingState,
            connectionState: peerConnectionRef.current.connectionState,
            iceConnectionState: peerConnectionRef.current.iceConnectionState
        });
        
        try {
            // Close all data channels
            const channels = peerConnectionRef.current.getDataChannels?.() || [];
            channels.forEach(channel => {
                console.log(`Closing data channel: ${channel.label}`);
                channel.close();
            });

            // Close all transceivers
            const transceivers = peerConnectionRef.current.getTransceivers?.() || [];
            transceivers.forEach(transceiver => {
                try {
                    console.log(`Stopping transceiver: ${transceiver.mid}`);
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
        console.log('Cleaning up audio element...');
        const srcObject = audioElementRef.current.srcObject;
        if (srcObject instanceof MediaStream) {
            console.log('Cleaning up audio element stream tracks...');
            srcObject.getTracks().forEach(track => {
                track.stop();
                console.log(`Stopped audio element track ${track.id}`);
            });
        }
        audioElementRef.current.pause();
        audioElementRef.current.srcObject = null;
        audioElementRef.current = null;
    }

    // Clean up audio context
    if (audioContextRef.current) {
        console.log('Cleaning up audio context...', {
            state: audioContextRef.current.state
        });
        
        if (audioContextRef.current.state !== 'closed') {
            try {
                // Disconnect all nodes
                const destination = audioContextRef.current.destination;
                if (destination) {
                    console.log('Disconnecting audio context destination');
                    const maxChannelCount = destination.maxChannelCount;
                    destination.channelCount = maxChannelCount;
                    destination.disconnect();
                }
                
                // Close the context
                audioContextRef.current.close().then(() => {
                    console.log('AudioContext closed successfully');
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
        console.log('Canceling animation frames...');
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

    console.log('Cleanup completed');
}; 