import { useRef, useState, createContext, useContext, useEffect } from 'react';
import vmsg from "vmsg";
import { downloadCardAudio } from '../db/supabase';

const recorder = new vmsg.Recorder({
  wasmURL: "https://unpkg.com/vmsg@0.3.0/vmsg.wasm"
});

// Create the context
const AudioContext = createContext(null);

// Create the provider component
export function AudioProvider({ children }) {
  const [isLoading, setIsLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState(null);
  
  // Basic audio playback state
  const audioRefs = useRef(new Map());
  const blobUrls = useRef(new Map());
  const evaluationAudioRef = useRef(new Audio());
  const audioCache = useRef(new Map());

  // Audio visualization state and refs
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioContextRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const playbackStreamRef = useRef(null);
  const animationFrameRef = useRef(null);
  const playbackAnimationFrameRef = useRef(null);

  // Track connected audio elements to prevent reconnection errors
  const connectedAudioElements = useRef(new WeakSet());

  // Create a global cache of audio sources to prevent reconnection errors
  useEffect(() => {
    // Create a cache on the window object if it doesn't exist
    if (!window.audioSourceCache) {
      window.audioSourceCache = new WeakMap();
    }
    
    // Cleanup on unmount
    return () => {
      // No cleanup needed for WeakMap as it will be garbage collected 
      // when audio elements are no longer referenced
    };
  }, []);

  // Setup audio context
  useEffect(() => {
    // Create audio context if it doesn't exist
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }

    // Clean up function
    return () => {
      // Cancel any animations
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (playbackAnimationFrameRef.current) {
        cancelAnimationFrame(playbackAnimationFrameRef.current);
      }

      // Stop any streams
      if (recordingStreamRef.current) {
        recordingStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // Handle recording state changes
  useEffect(() => {
    const setupRecordingStream = async () => {
      // If we're starting to record
      if (isRecording) {
        try {
          // Get user media stream for visualization
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          
          // If we have an existing stream, disconnect and clean it up first
          if (recordingStreamRef.current) {
            recordingStreamRef.current.getTracks().forEach(track => track.stop());
          }
          
          // Set the new stream
          recordingStreamRef.current = stream;
        } catch (error) {
          console.error('Error getting microphone stream for visualization:', error);
        }
      } else {
        // When we stop recording, don't immediately stop the stream
        // We'll let the cleanup effect handle this when appropriate
      }
    };

    setupRecordingStream();
  }, [isRecording]);

  // Track audio playback state
  useEffect(() => {
    const setupPlaybackListeners = () => {
      const listeners = new Map();
      const audioSources = new Map();
      
      // Find all audio elements from audio context
      audioRefs.current.forEach((audioElement, path) => {
        // Check global cache first
        if (window.audioSourceCache && window.audioSourceCache.has(audioElement)) {
          console.log('Audio element found in global cache, reusing:', path);
          const { source, destination } = window.audioSourceCache.get(audioElement);
          audioSources.set(audioElement, { source, destination });
        } 
        // If not in global cache and not connected, create new source
        else if (!connectedAudioElements.current.has(audioElement) && audioContextRef.current) {
          try {
            // Create a MediaElementAudioSourceNode
            const source = audioContextRef.current.createMediaElementSource(audioElement);
            // Connect to destination to hear the audio
            source.connect(audioContextRef.current.destination);
            
            // Create a MediaStream from the audio context for visualization
            const destination = audioContextRef.current.createMediaStreamDestination();
            source.connect(destination);
            
            // Store the source and destination
            audioSources.set(audioElement, { source, destination });
            
            // Mark this element as connected in both local and global caches
            connectedAudioElements.current.add(audioElement);
            if (window.audioSourceCache) {
              window.audioSourceCache.set(audioElement, { source, destination });
            }
            console.log('Connected new audio element:', path);
          } catch (error) {
            console.error('Error setting up audio visualization for playback:', error);
          }
        } else {
          console.log('Audio element already connected, skipping:', path);
        }
        
        // Create play handler
        const playHandler = () => {
          console.log('Audio playing:', path);
          setIsPlayingAudio(true);
          
          // Set the current playback stream for visualization
          const sourceInfo = window.audioSourceCache?.get(audioElement) || audioSources.get(audioElement);
          if (sourceInfo) {
            playbackStreamRef.current = sourceInfo.destination.stream;
            console.log('Playback stream set');
          }
        };
        
        // Create ended handler
        const endedHandler = () => {
          console.log('Audio ended:', path);
          setIsPlayingAudio(false);
          // Small delay before clearing the stream to allow for visualization to complete
          setTimeout(() => {
            if (!isPlayingAudio) {
              playbackStreamRef.current = null;
            }
          }, 100);
        };
        
        // Store handlers so we can remove them later
        listeners.set(audioElement, { playHandler, endedHandler });
        
        // Remove existing listeners to prevent duplicates
        audioElement.removeEventListener('play', playHandler);
        audioElement.removeEventListener('ended', endedHandler);
        
        // Add play event listener
        audioElement.addEventListener('play', playHandler);
        
        // Add ended event listener
        audioElement.addEventListener('ended', endedHandler);
      });
      
      // Evaluation audio handling
      if (evaluationAudioRef.current) {
        // Check global cache first
        if (window.audioSourceCache && window.audioSourceCache.has(evaluationAudioRef.current)) {
          console.log('Evaluation audio element found in global cache, reusing');
          const { source, destination } = window.audioSourceCache.get(evaluationAudioRef.current);
          audioSources.set(evaluationAudioRef.current, { source, destination });
        }
        // If not in global cache and not already connected
        else if (!connectedAudioElements.current.has(evaluationAudioRef.current) && audioContextRef.current) {
          try {
            const source = audioContextRef.current.createMediaElementSource(evaluationAudioRef.current);
            source.connect(audioContextRef.current.destination);
            
            const destination = audioContextRef.current.createMediaStreamDestination();
            source.connect(destination);
            
            audioSources.set(evaluationAudioRef.current, { source, destination });
            
            // Mark this element as connected in both local and global caches
            connectedAudioElements.current.add(evaluationAudioRef.current);
            if (window.audioSourceCache) {
              window.audioSourceCache.set(evaluationAudioRef.current, { source, destination });
            }
            console.log('Connected new evaluation audio element');
          } catch (error) {
            console.error('Error setting up audio visualization for evaluation:', error);
          }
        } else {
          console.log('Evaluation audio element already connected, skipping');
        }
        
        // Create play handler for evaluation audio
        const evalPlayHandler = () => {
          console.log('Evaluation audio playing');
          setIsPlayingAudio(true);
          
          // Get source from global cache or local map
          const sourceInfo = window.audioSourceCache?.get(evaluationAudioRef.current) || 
                            audioSources.get(evaluationAudioRef.current);
          if (sourceInfo) {
            playbackStreamRef.current = sourceInfo.destination.stream;
            console.log('Evaluation playback stream set');
          }
        };
        
        const evalEndedHandler = () => {
          console.log('Evaluation audio ended');
          setIsPlayingAudio(false);
          setTimeout(() => {
            if (!isPlayingAudio) {
              playbackStreamRef.current = null;
            }
          }, 100);
        };
        
        listeners.set(evaluationAudioRef.current, { 
          playHandler: evalPlayHandler, 
          endedHandler: evalEndedHandler 
        });
        
        // Remove existing listeners to prevent duplicates
        evaluationAudioRef.current.removeEventListener('play', evalPlayHandler);
        evaluationAudioRef.current.removeEventListener('ended', evalEndedHandler);
        
        // Add event listeners
        evaluationAudioRef.current.addEventListener('play', evalPlayHandler);
        evaluationAudioRef.current.addEventListener('ended', evalEndedHandler);
      }
      
      // Return cleanup function
      return { listeners, audioSources };
    };
    
    const { listeners, audioSources } = setupPlaybackListeners();
    
    // Cleanup function
    return () => {
      listeners.forEach((handlers, element) => {
        element.removeEventListener('play', handlers.playHandler);
        element.removeEventListener('ended', handlers.endedHandler);
      });
    };
  }, [audioRefs.current.size]);

  // Setup audio context cleanup on unmount
  useEffect(() => {
    return () => {
      // Don't reset the connected elements set when component unmounts
      // since the same audio elements might be reused across renders
      
      // If we have an audio context, close it
      if (audioContextRef.current) {
        audioContextRef.current.close().catch(e => {
          console.error('Error closing AudioContext:', e);
        });
        audioContextRef.current = null;
      }
    };
  }, []);

  // Ensure audio context is in the right state before use
  const ensureAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      console.log("Created new AudioContext");
    } else if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
      console.log("Resumed AudioContext");
    }
    return audioContextRef.current;
  };

  // Helper function to get audio from storage
  const getAudioFromStorage = (audioPath) => {
    const audioData = JSON.parse(localStorage.getItem(`audio_storage/${audioPath}`));
    if (!audioData) {
      return null;
    }
    
    try {
      const blob = dataURLtoBlob(audioData.data);
      const url = URL.createObjectURL(blob);
      return url;
    } catch (err) {
      return null;
    }
  };

  // Helper function to convert data URL to Blob
  const dataURLtoBlob = (dataurl) => {
    try {
      const arr = dataurl.split(',');
      const mime = arr[0].match(/:(.*?);/)[1];
      
      // Ensure we're dealing with audio data
      if (!mime.startsWith('audio/')) {
        throw new Error('Invalid audio data');
      }

      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      const blob = new Blob([u8arr], { type: 'audio/mp3' }); // Force MP3 type
      return blob;
    } catch (err) {
      throw new Error('Failed to convert audio data');
    }
  };

  const startRecording = async () => {
    setIsLoading(true);
    try {
      await ensureAudioContext();
      await recorder.initAudio();
      await recorder.initWorker();
      recorder.startRecording();
      setIsLoading(false);
      setIsRecording(true);
    } catch (e) {
      setError('Failed to start recording: ' + e.message);
      setIsLoading(false);
    }
  };

  const stopRecording = async () => {
    try {
      const audioBlob = await recorder.stopRecording();
      setIsRecording(false);

      if (audioBlob.size === 0) {
        setError('No audio data recorded. Please try again.');
        return null;
      }

      return audioBlob;
    } catch (err) {
      setError('Failed to stop recording: ' + err.message);
      setIsRecording(false);
      return null;
    }
  };

  const loadAudio = async (audioPath) => {
    try {
      if (!audioPath) {
        throw new Error('Audio path is required');
      }

      let audioUrl;
      
      // First try to get audio from local storage
      audioUrl = getAudioFromStorage(audioPath);
      if (audioUrl) {
        // Create new audio element if needed
        if (!audioRefs.current.has(audioPath)) {
          audioRefs.current.set(audioPath, new Audio());
        }
        const audioRef = audioRefs.current.get(audioPath);
        audioRef.src = audioUrl;
        blobUrls.current.set(audioPath, audioUrl);
        return audioUrl;
      }
      
      // If not in storage, try to download and cache it
      // Check cache first
      if (audioCache.current.has(audioPath)) {
        audioUrl = audioCache.current.get(audioPath);
      } else {
        // Download and cache if not found
        audioUrl = await downloadCardAudio(audioPath);
        if (audioUrl) {
          audioCache.current.set(audioPath, audioUrl);
        }
      }

      if (audioUrl) {
        if (!audioRefs.current.has(audioPath)) {
          audioRefs.current.set(audioPath, new Audio());
        }
        const audioRef = audioRefs.current.get(audioPath);
        audioRef.src = audioUrl;
        blobUrls.current.set(audioPath, audioUrl);
        return audioUrl;
      }
      
      // If no audio found anywhere, check if we have an existing ref as last resort
      if (audioRefs.current.has(audioPath)) {
        const audioRef = audioRefs.current.get(audioPath);
        if (!audioRef.src) {
          throw new Error('No audio available');
        }
        return audioRef.src;
      }
      
      throw new Error('No audio available');
    } catch (err) {
      setError(`Failed to load audio: ${err.message}`);
      throw err;
    }
  };

  const playAudio = async (audioPath, shouldPlay = true) => {
    try {
      await ensureAudioContext();
      
      // Stop all currently playing audio
      for (const audio of audioRefs.current.values()) {
        audio.pause();
        audio.currentTime = 0;
      }

      let audioUrl;
      
      // Check cache first
      if (audioCache.current.has(audioPath)) {
        audioUrl = audioCache.current.get(audioPath);
      } else {
        // Download and cache if not found
        audioUrl = await downloadCardAudio(audioPath);
        if (audioUrl) {
          audioCache.current.set(audioPath, audioUrl);
        }
      }

      if (!audioUrl) {
        throw new Error('Failed to load audio');
      }

      // Only play if requested
      if (shouldPlay) {
        if (!audioRefs.current.has(audioPath)) {
          audioRefs.current.set(audioPath, new Audio());
        }
        const audioRef = audioRefs.current.get(audioPath);
        audioRef.src = audioUrl;
        await audioRef.play();
      }
    } catch (err) {
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
    for (const [path, url] of blobUrls.current.entries()) {
      URL.revokeObjectURL(url);
      const audioRef = audioRefs.current.get(path);
      if (audioRef) {
        audioRef.src = '';
      }
    }
    blobUrls.current.clear();
    audioRefs.current.clear();
  };

  const contextValue = {
    isLoading,
    isRecording,
    error,
    evaluationAudioRef,
    startRecording,
    stopRecording,
    playAudio,
    loadAudio,
    cleanupAudioUrls,
    setError,
    audioRefs,
    // Visualization related exports
    isPlayingAudio,
    audioContextRef,
    recordingStreamRef,
    playbackStreamRef,
    animationFrameRef,
    playbackAnimationFrameRef,
    ensureAudioContext
  };

  return (
    <AudioContext.Provider value={contextValue}>
      {children}
    </AudioContext.Provider>
  );
}

// Create a hook to use the audio context
export function useAudio() {
  const context = useContext(AudioContext);
  if (context === null) {
    throw new Error('useAudio must be used within an AudioProvider');
  }
  return context;
} 