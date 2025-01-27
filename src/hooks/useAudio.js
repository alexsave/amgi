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

  const playAudio = async (audioUrl) => {
    try {
      console.log('Playing audio URL:', audioUrl);
      
      if (!audioUrl) {
        throw new Error('No audio available');
      }

      // Stop any currently playing audio
      frontAudioRef.current.pause();
      frontAudioRef.current.currentTime = 0;
      backAudioRef.current.pause();
      backAudioRef.current.currentTime = 0;

      // Create a new audio element for this playback
      const audio = new Audio(audioUrl);
      await audio.play();
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