import { useRef, useState } from 'react';
import vmsg from "vmsg";
import { downloadCardAudio } from '../db/supabase';

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
  // Cache for downloaded audio files
  const audioCache = useRef(new Map());

  // Helper function to get audio from storage
  const getAudioById = (audioId) => {
    console.log('useAudio: Getting audio by ID:', audioId);
    const audioData = JSON.parse(localStorage.getItem(`audio_storage/${audioId}`));
    if (!audioData) {
      console.warn('useAudio: No audio data found for ID:', audioId);
      return null;
    }
    
    try {
      const blob = dataURLtoBlob(audioData.data);
      const url = URL.createObjectURL(blob);
      console.log('useAudio: Created URL for audio:', {
        blobSize: blob.size,
        blobType: blob.type,
        url
      });
      return url;
    } catch (err) {
      console.error('useAudio: Error creating audio URL:', err);
      return null;
    }
  };

  // Helper function to convert data URL to Blob
  const dataURLtoBlob = (dataurl) => {
    try {
      console.log('useAudio: Converting data URL to blob, prefix:', dataurl.substring(0, 50));
      const arr = dataurl.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      console.log('useAudio: Extracted MIME type:', mime);
      
      // Ensure we're dealing with audio data
      if (!mime.startsWith('audio/')) {
        console.error('useAudio: Invalid MIME type:', mime);
        throw new Error('Invalid audio data');
      }

      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      const blob = new Blob([u8arr], { type: 'audio/mp3' }); // Force MP3 type
      console.log('useAudio: Created blob:', {
        size: blob.size,
        type: blob.type
      });
      return blob;
    } catch (err) {
      console.error('useAudio: Error converting data URL to blob:', err);
      throw new Error('Failed to convert audio data');
    }
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

  const loadAudio = async (side, audioId) => {
    try {
      
      let audioUrl;
      
      // First try to get audio from storage if we have an ID
      if (audioId) {
        audioUrl = getAudioById(audioId);
        if (!audioUrl) {
          console.warn(`No audio found in storage for ID: ${audioId}`);
        } else {
          // Set the audio ref's source
          const audioRef = side === 'front' ? frontAudioRef.current : backAudioRef.current;
          audioRef.src = audioUrl;
          blobUrlsRef.current[side] = audioUrl;
          console.log(`useAudio: Set ${side} audio ref source:`, audioUrl);
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

      return audioUrl;
    } catch (err) {
      console.error('Error loading audio:', err);
      setError(`Failed to load audio: ${err.message}`);
      throw err;
    }
  };

  const playAudio = async (side, audioPath, shouldPlay = true) => {
    try {
      console.log('Playing audio for side:', side, 'with path:', audioPath);
      
      // Stop any currently playing audio
      frontAudioRef.current.pause();
      frontAudioRef.current.currentTime = 0;
      backAudioRef.current.pause();
      backAudioRef.current.currentTime = 0;

      let audioUrl;
      
      // Check cache first
      if (audioCache.current.has(audioPath)) {
        console.log('Found audio in cache:', audioPath);
        audioUrl = audioCache.current.get(audioPath);
      } else {
        // Download and cache if not found
        console.log('Downloading audio:', audioPath);
        audioUrl = await downloadCardAudio(audioPath);
        if (audioUrl) {
          console.log('Caching audio:', audioPath);
          audioCache.current.set(audioPath, audioUrl);
        }
      }

      if (!audioUrl) {
        throw new Error('Failed to load audio');
      }

      // Only play if requested
      if (shouldPlay) {
        const audioRef = side === 'front' ? frontAudioRef.current : backAudioRef.current;
        audioRef.src = audioUrl;
        await audioRef.play();
      }
    } catch (err) {
      console.error('Error playing audio:', err);
      setError(`Failed to play audio: ${err.message}`);
      throw err;
    }
  };

  const cleanupAudioUrls = () => {
    // Revoke all cached URLs
    for (const url of audioCache.current.values()) {
      URL.revokeObjectURL(url);
    }
    audioCache.current.clear();

    // Clean up current audio refs
    if (blobUrlsRef.current.front) {
      URL.revokeObjectURL(blobUrlsRef.current.front);
    }
    if (blobUrlsRef.current.back) {
      URL.revokeObjectURL(blobUrlsRef.current.back);
    }
    blobUrlsRef.current = { front: null, back: null };
    frontAudioRef.current.src = '';
    backAudioRef.current.src = '';
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
    loadAudio,
    cleanupAudioUrls,
    setError
  };
} 