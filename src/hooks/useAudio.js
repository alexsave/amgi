import { useRef, useState } from 'react';
import vmsg from "vmsg";

const recorder = new vmsg.Recorder({
  wasmURL: "https://unpkg.com/vmsg@0.3.0/vmsg.wasm"
});

export function useAudio() {
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState(null);
  
  const frontAudioRef = useRef(new Audio());
  const backAudioRef = useRef(new Audio());
  const blobUrlsRef = useRef({ front: null, back: null });
  const evaluationAudioRef = useRef(new Audio());

  // Helper function to get audio from storage
  const getAudioById = (audioId) => {
    const audioData = JSON.parse(sessionStorage.getItem(`audio_storage/${audioId}`));
    if (!audioData) return null;
    
    const blob = dataURLtoBlob(audioData.data);
    return URL.createObjectURL(blob);
  };

  // Helper function to convert data URL to Blob
  const dataURLtoBlob = (dataurl) => {
    const arr = dataurl.split(',');
    const mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  };

  const startRecording = async () => {
    setIsLoading(true);
    try {
      await recorder.initAudio();
      await recorder.initWorker();
      recorder.startRecording();
      setIsLoading(false);
      setIsRecording(true);
    } catch (e) {
      console.error('Error starting recording:', e);
      setError('Failed to start recording: ' + e.message);
      setIsLoading(false);
    }
  };

  const stopRecording = async () => {
    try {
      console.log('Stopping recording...');
      const audioBlob = await recorder.stopRecording();
      console.log('Got audio blob:', audioBlob);
      setIsRecording(false);

      if (audioBlob.size === 0) {
        console.error('No audio data recorded');
        setError('No audio data recorded. Please try again.');
        return null;
      }

      return audioBlob;
    } catch (err) {
      console.error('Error stopping recording:', err);
      setError('Failed to stop recording: ' + err.message);
      setIsRecording(false);
      return null;
    }
  };

  const playAudio = async (side, audioId) => {
    try {
      console.log('Playing audio for side:', side, 'with ID:', audioId);
      
      // Stop any currently playing audio
      frontAudioRef.current.pause();
      frontAudioRef.current.currentTime = 0;
      backAudioRef.current.pause();
      backAudioRef.current.currentTime = 0;

      let audioUrl;
      
      // First try to get audio from storage if we have an ID
      if (audioId) {
        audioUrl = getAudioById(audioId);
        if (!audioUrl) {
          console.warn(`No audio found in storage for ID: ${audioId}`);
        }
      }
      
      // If no audio in storage, fall back to URL in audio refs
      if (!audioUrl) {
        const audioRef = side === 'front' ? frontAudioRef.current : backAudioRef.current;
        if (!audioRef.src) {
          throw new Error('No audio available');
        }
        audioUrl = audioRef.src;
      }

      // Create a new audio element for this playback
      const audio = new Audio(audioUrl);
      await audio.play();
      
      // Clean up URL if it was created from storage
      if (audioId) {
        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
        };
      }
    } catch (err) {
      console.error('Error playing audio:', err);
      setError(`Failed to play audio: ${err.message}`);
    }
  };

  const cleanupAudioUrls = () => {
    if (blobUrlsRef.current.front) {
      URL.revokeObjectURL(blobUrlsRef.current.front);
    }
    if (blobUrlsRef.current.back) {
      URL.revokeObjectURL(blobUrlsRef.current.back);
    }
    blobUrlsRef.current = { front: null, back: null };
  };

  return {
    isLoading,
    isRecording,
    error,
    frontAudioRef,
    backAudioRef,
    blobUrlsRef,
    evaluationAudioRef,
    startRecording,
    stopRecording,
    playAudio,
    cleanupAudioUrls,
    setError
  };
} 