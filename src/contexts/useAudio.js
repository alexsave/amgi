import { useRef, useState, createContext, useContext, useEffect } from 'react';
import vmsg from "vmsg";
import { downloadCardAudio } from '../db/supabase';

// The recorder touches browser globals as soon as it's constructed, and the
// encoder wasm is served from this app rather than a third-party CDN, so an
// outage (or an offline user) can't break recording.
let recorderInstance = null;
const getRecorder = () => {
  if (!recorderInstance) {
    recorderInstance = new vmsg.Recorder({ wasmURL: '/vmsg.wasm' });
  }
  return recorderInstance;
};

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
  const pendingPlayRequests = useRef(new Map()); // Track play requests by path

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

  // Mirror of isPlayingAudio that callbacks can read without re-subscribing.
  const isPlayingAudioRef = useRef(false);
  useEffect(() => {
    isPlayingAudioRef.current = isPlayingAudio;
  }, [isPlayingAudio]);

  // Handle recording state changes
  useEffect(() => {
    const setupRecordingStream = async () => {
      // If we're starting to record
      if (isRecording) {
        try {
          // If we don't already have a stream (should have been created in startRecording)
          if (!recordingStreamRef.current) {
            // Get user media stream for visualization
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // Set the new stream
            recordingStreamRef.current = stream;
          }
          
          // Ensure audio context is resumed
          if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
            await audioContextRef.current.resume();
          }
        } catch (error) {
          console.error('Error getting microphone stream for visualization:', error);
        }
      } else {
        // When we stop recording, don't immediately stop the stream
        // We'll leave it for a moment to allow the visualizer to show decay
        if (recordingStreamRef.current) {
          setTimeout(() => {
            // Only stop if we're still not recording
            if (!isRecording && recordingStreamRef.current) {
              recordingStreamRef.current.getTracks().forEach(track => track.stop());
              // Don't set to null immediately to allow decay animation
              setTimeout(() => {
                if (!isRecording) {
                  recordingStreamRef.current = null;
                }
              }, 2000);
            }
          }, 2000);
        }
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
          } catch (error) {
            console.error('Error setting up audio visualization for playback:', error);
          }
        }
        
        // Create play handler
        const playHandler = () => {
          setIsPlayingAudio(true);
          
          // Set the current playback stream for visualization
          const sourceInfo = window.audioSourceCache?.get(audioElement) || audioSources.get(audioElement);
          if (sourceInfo) {
            playbackStreamRef.current = sourceInfo.destination.stream;
          }
        };
        
        // Create ended handler
        const endedHandler = () => {
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
          } catch (error) {
            console.error('Error setting up audio visualization for evaluation:', error);
          }
        }
        
        // Create play handler for evaluation audio
        const evalPlayHandler = () => {
          setIsPlayingAudio(true);
          
          // Get source from global cache or local map
          const sourceInfo = window.audioSourceCache?.get(evaluationAudioRef.current) || 
                            audioSources.get(evaluationAudioRef.current);
          if (sourceInfo) {
            playbackStreamRef.current = sourceInfo.destination.stream;
          }
        };
        
        const evalEndedHandler = () => {
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
    
    const { listeners } = setupPlaybackListeners();
    
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
    } else if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  // Helper function to get audio from storage
  const getAudioFromStorage = (audioPath) => {
    return null;
  };

  const startRecording = async () => {
    setIsLoading(true);
    try {
      await ensureAudioContext();
      const recorder = getRecorder();
      await recorder.initAudio();
      await recorder.initWorker();
      
      // Get user media stream for visualization BEFORE starting recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        // Clean up existing stream if any
        if (recordingStreamRef.current) {
          recordingStreamRef.current.getTracks().forEach(track => track.stop());
        }
        
        // Set the new stream immediately
        recordingStreamRef.current = stream;
      } catch (streamError) {
        console.error('Error getting microphone stream for visualization:', streamError);
      }
      
      // Start the actual recording now that we have a stream
      recorder.startRecording();
      setIsLoading(false);
      setIsRecording(true);
      
      // Force the audio context to resume if suspended
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        try {
          await audioContextRef.current.resume();
        } catch (resumeError) {
          console.error('Error resuming AudioContext:', resumeError);
        }
      }
    } catch (e) {
      setError('Failed to start recording: ' + e.message);
      setIsLoading(false);
    }
  };

  const stopRecording = async () => {
    try {
      const audioBlob = await getRecorder().stopRecording();
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

  // Plays a clip and resolves once it has finished. Playback runs through
  // several code paths in here (buffer source, media element, Safari decode),
  // all of which report through isPlayingAudio, so we watch that rather than
  // hooking each one. The timeouts keep a stalled clip from wedging the
  // review loop.
  const playAudioToEnd = async (audioPath, { startTimeoutMs = 2000, maxDurationMs = 30000 } = {}) => {
    if (!audioPath) return;

    await playAudio(audioPath);

    const waitFor = (predicate, timeoutMs) =>
      new Promise((resolve) => {
        const startedAt = Date.now();
        const tick = () => {
          if (predicate() || Date.now() - startedAt >= timeoutMs) return resolve();
          setTimeout(tick, 60);
        };
        tick();
      });

    // Playback state flips asynchronously; wait for it to start, then to end.
    await waitFor(() => isPlayingAudioRef.current, startTimeoutMs);
    await waitFor(() => !isPlayingAudioRef.current, maxDurationMs);
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
          const audio = new Audio();
          // SAFARI FIX: Set preload attribute to help prevent cutoff
          audio.preload = 'auto';
          audioRefs.current.set(audioPath, audio);
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
          const audio = new Audio();
          // SAFARI FIX: Set preload attribute to help prevent cutoff
          audio.preload = 'auto';
          audioRefs.current.set(audioPath, audio);
        }
        const audioRef = audioRefs.current.get(audioPath);
        audioRef.src = audioUrl;
        
        // SAFARI FIX: Trigger load and prefetch
        try {
          audioRef.load();
          // Start buffering without playing
          await new Promise((resolve) => {
            const canLoadData = () => {
              audioRef.removeEventListener('loadeddata', canLoadData);
              resolve();
            };
            audioRef.addEventListener('loadeddata', canLoadData);
            // If already loaded, resolve immediately
            if (audioRef.readyState >= 2) {
              resolve();
            }
          });
        } catch (e) {
          console.warn('Pre-buffering failed, but continuing:', e);
        }
        
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
      
      // Cancel any pending play requests first
      for (const [path, controller] of pendingPlayRequests.current.entries()) {
        controller.abort();
        pendingPlayRequests.current.delete(path);
      }
      
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
          const audio = new Audio();
          audio.preload = 'auto';
          audioRefs.current.set(audioPath, audio);
        }
        const audioElement = audioRefs.current.get(audioPath);
        
        // Create an abort controller for this play request
        const controller = new AbortController();
        pendingPlayRequests.current.set(audioPath, controller);
        
        // Detect if we're running on Safari
        const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent) || 
                         (navigator.userAgent.includes('AppleWebKit') && !navigator.userAgent.includes('Chrome'));
        
        // ===== RAW BUFFER APPROACH FOR SAFARI =====
        if (isSafari) {
          try {
            // Fetch the audio file directly as ArrayBuffer
            const response = await fetch(audioUrl);
            
            if (!response.ok) {
              throw new Error(`Failed to fetch audio file: ${response.statusText}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            
            // Decode the audio data
            const audioBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
            
            // Set up visualizer - we'll create a special stream for visualization
            // since we're not using an audio element
            try {
              // Create a gain node to route our audio through
              const gainNode = audioContextRef.current.createGain();
              gainNode.gain.value = 1.0;
              gainNode.connect(audioContextRef.current.destination);
              
              // Create destination for visualization
              const destination = audioContextRef.current.createMediaStreamDestination();
              gainNode.connect(destination);
              
              // Set the playback stream for visualization
              playbackStreamRef.current = destination.stream;
              
              // Set playing state before we start actual playback
              setIsPlayingAudio(true);
              
              // Create a buffer source node
              const sourceNode = audioContextRef.current.createBufferSource();
              sourceNode.buffer = audioBuffer;
              
              // Connect to our routing
              sourceNode.connect(gainNode);
              
              // Play from beginning
              sourceNode.start(0);
              
              // Set up ended event handling
              sourceNode.onended = () => {
                setIsPlayingAudio(false);
                
                // Clean up request controller
                pendingPlayRequests.current.delete(audioPath);
                
                // Don't immediately clear stream to allow for decay animation
                setTimeout(() => {
                  if (!isPlayingAudio) {
                    playbackStreamRef.current = null;
                  }
                }, 2000);
              };
              
              // Set the Audio element src for completeness (won't actually be played)
              // This ensures that it's part of our regular Audio element tracking
              audioElement.src = audioUrl;
              
              return; // Skip the regular approach
            } catch (visualizationError) {
              // Continue setup without visualization
            }
            
            // Fallback without visualization if that failed
            setIsPlayingAudio(true);
            
            // Create and play buffer directly
            const sourceNode = audioContextRef.current.createBufferSource();
            sourceNode.buffer = audioBuffer;
            sourceNode.connect(audioContextRef.current.destination);
            
            // Play from beginning
            sourceNode.start(0);
            
            // Set up ended event
            sourceNode.onended = () => {
                setIsPlayingAudio(false);
                pendingPlayRequests.current.delete(audioPath);
            };
            
            return; // Skip regular approach
          } catch (bufferError) {
            // Fall through to double-play approach
          }
          
          try {
            // Set source first (we'll handle playback specially)
            audioElement.src = audioUrl;
            
            // Make sure preload is set 
            audioElement.preload = 'auto';
            
            // Force loading the audio data
            audioElement.load();
            
            // Connect to Web Audio API if not already connected
            let source, destination;
            if (!connectedAudioElements.current.has(audioElement) && audioContextRef.current) {
              try {
                // Create a MediaElementAudioSourceNode
                source = audioContextRef.current.createMediaElementSource(audioElement);
                // Connect to destination to hear the audio
                source.connect(audioContextRef.current.destination);
                
                // Create a MediaStream for visualization
                destination = audioContextRef.current.createMediaStreamDestination();
                source.connect(destination);
                
                playbackStreamRef.current = destination.stream;
                connectedAudioElements.current.add(audioElement);
                if (window.audioSourceCache) {
                  window.audioSourceCache.set(audioElement, { source, destination });
                }
              } catch (error) {
                // Connection failed, continue
              }
            } else if (window.audioSourceCache && window.audioSourceCache.has(audioElement)) {
              const sourceInfo = window.audioSourceCache.get(audioElement);
              source = sourceInfo.source;
              destination = sourceInfo.destination;
              playbackStreamRef.current = destination.stream;
            }
            
            // Set state to playing
            setIsPlayingAudio(true);
            
            // Wait for audio to be loaded
            await new Promise((resolve) => {
              const loadHandler = () => {
                audioElement.removeEventListener('loadeddata', loadHandler);
                resolve();
              };
              
              if (audioElement.readyState >= 2) {
                resolve();
              } else {
                audioElement.addEventListener('loadeddata', loadHandler);
              }
            });
            
            // Add extra pre-buffer delay
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // SAFARI AUDIO FIX: Add additional silence to beginning
            try {
              // Create a context for mixing
              const offlineCtx = new OfflineAudioContext({
                numberOfChannels: 2,
                length: 44100, // 1 second at 44.1kHz
                sampleRate: 44100,
              });
              
              // Play silent audio first to "warm up" Safari's audio system
              const silentBuffer = offlineCtx.createBuffer(2, 22050, 44100); // 0.5s of silence
              const silentSource = audioContextRef.current.createBufferSource();
              silentSource.buffer = silentBuffer;
              silentSource.connect(audioContextRef.current.destination);
              silentSource.start();
              silentSource.stop(audioContextRef.current.currentTime + 0.1); // Stop after 100ms
              
              await new Promise(resolve => setTimeout(resolve, 100)); // Wait for silent audio
            } catch (silentError) {
              // Silent audio failed, continue anyway
            }
            
            // Reset position to start
            audioElement.currentTime = 0;
            
            // === SAFARI TRIPLE-PLAY TECHNIQUE ===
            // First play attempt - this may have cut-off but "warms up" the audio system
            await audioElement.play().catch(() => {});
            
            // Immediate pause and reset
            audioElement.pause();
            audioElement.currentTime = 0;
            
            // Short delay between plays
            await new Promise(resolve => setTimeout(resolve, 70));
            
            // Second play attempt - may still cut off but further primes the system
            await audioElement.play().catch(() => {});
            
            // Immediate pause and reset
            audioElement.pause();
            audioElement.currentTime = 0;
            
            // Longer delay between second and third plays
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Third play attempt - this should play correctly without cutoff
            await audioElement.play();
            
            // Clean up controller
            pendingPlayRequests.current.delete(audioPath);
            
            // Add ended handler
            audioElement.onended = () => {
              setIsPlayingAudio(false);
              setTimeout(() => {
                if (!isPlayingAudio) {
                  playbackStreamRef.current = null;
                }
              }, 2000);
            };
            
            return; // Skip the regular playback code path
          } catch (safariError) {
            // Continue with standard playback as fallback
          }
        }
        
        // ===== STANDARD APPROACH FOR NON-SAFARI =====
        // Set source first and wait for it to load before attempting to play
        audioElement.src = audioUrl;
        
        // Make sure preload is set 
        audioElement.preload = 'auto';
        
        // Force loading the audio data
        audioElement.load();
        
        // Ensure we have a source node connected for visualization
        if (!connectedAudioElements.current.has(audioElement)) {
          try {
            // Create a MediaElementAudioSourceNode
            const source = audioContextRef.current.createMediaElementSource(audioElement);
            // Connect to destination to hear the audio
            source.connect(audioContextRef.current.destination);
            
            // Create a MediaStream from the audio context for visualization
            const destination = audioContextRef.current.createMediaStreamDestination();
            source.connect(destination);
            
            // Set the playback stream reference for visualization immediately
            playbackStreamRef.current = destination.stream;
            
            // Mark this element as connected
            connectedAudioElements.current.add(audioElement);
            
            // Store in global cache if available
            if (window.audioSourceCache) {
              window.audioSourceCache.set(audioElement, { source, destination });
            }
          } catch (error) {
            pendingPlayRequests.current.delete(audioPath);
            console.error('Error setting up audio source for visualization:', error);
          }
        } else if (window.audioSourceCache && window.audioSourceCache.has(audioElement)) {
          // If already connected, get the stream from cache
          const { destination } = window.audioSourceCache.get(audioElement);
          playbackStreamRef.current = destination.stream;
        }
        
        // Set state to playing before actually playing
        // This ensures the visualizer can start preparing right away
        setIsPlayingAudio(true);
        
        // For Safari, wait for loadeddata instead of just canplay for better buffering
        const waitForAudioReady = new Promise((resolve) => {
          if (isSafari) {
            const loadedDataHandler = () => {
              audioElement.removeEventListener('loadeddata', loadedDataHandler);
              resolve();
            };
            
            if (audioElement.readyState >= 2) {
              resolve();
            } else {
              audioElement.addEventListener('loadeddata', loadedDataHandler);
            }
          } else {
            // For non-Safari, use canplay as before
            const canPlayHandler = () => {
              audioElement.removeEventListener('canplay', canPlayHandler);
              resolve();
            };
            
            if (audioElement.readyState >= 3) {
              resolve();
            } else {
              audioElement.addEventListener('canplay', canPlayHandler);
            }
          }
        });
        
        try {
          // Wait for the audio to be ready to play
          await Promise.race([
            waitForAudioReady,
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => 
                reject(new Error('Play request aborted'))
              );
            })
          ]);
          
          // Add a delay to ensure buffer is loaded
          if (isSafari) {
            await new Promise(resolve => setTimeout(resolve, 300));
          } else {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
          // Now try to play if this request hasn't been aborted
          if (!controller.signal.aborted) {
            // Reset current time to ensure we start from the beginning
            audioElement.currentTime = 0;
            
            // Create a silent buffer and play it first to "warm up" the audio context
            if (isSafari && audioContextRef.current) {
              try {
                const silentBuffer = audioContextRef.current.createBuffer(1, 1, 22050);
                const silentSource = audioContextRef.current.createBufferSource();
                silentSource.buffer = silentBuffer;
                silentSource.connect(audioContextRef.current.destination);
                silentSource.start();
                // Wait a tiny bit after playing the silent buffer
                await new Promise(resolve => setTimeout(resolve, 20));
              } catch (warmupError) {
                // Silent buffer failed, continue anyway
              }
            }
            
            const playPromise = audioElement.play();
            
            await playPromise;
            
            // Clean up this request's controller now that it's successfully playing
            pendingPlayRequests.current.delete(audioPath);
          }
        } catch (playError) {
          pendingPlayRequests.current.delete(audioPath);
          // Don't log abort errors from our own cancellations
          if (playError.message !== 'Play request aborted') {
            console.error('Error starting audio playback:', playError);
          }
          setIsPlayingAudio(false); // Reset state if playback fails
          throw playError;
        }
        
        // Set up ended handler to reset state
        audioElement.onended = () => {
          setIsPlayingAudio(false);
          // Don't immediately clear the stream to allow for decay animation
          setTimeout(() => {
            if (!isPlayingAudio) {
              playbackStreamRef.current = null;
            }
          }, 2000);
        };
      }
    } catch (err) {
      // Don't show error for aborted requests
      if (err.message !== 'Play request aborted') {
        setError(`Failed to play audio: ${err.message}`);
        throw err;
      }
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
    playAudioToEnd,
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