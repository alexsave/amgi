import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { MicrophoneIcon, PlayIcon } from '@heroicons/react/24/solid';
import { useNavigate } from 'react-router-dom';
import EvaluationResult from './EvaluationResult';
import { useAudio } from '../../contexts/useAudio';
import { useReview } from '../../contexts/ReviewContext';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import RadialAudioVisualizer from './RadialAudioVisualizer';
import './ReviewMode.css';

const ReviewMode = () => {
  const { decks, currentDeckId } = useDecks();
  const navigate = useNavigate();
  const audio = useAudio();
  const review = useReview();
  const [isRecording, setIsRecording] = useState(false);
  const { currentCard, currentCardId, attempts, showAnswer, evaluationResult, newCardsCount, reviewCardsCount, learningCardsCount } = review;
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [transitionTimeLeft, setTransitionTimeLeft] = useState(0);
  const transitionTimerRef = useRef(null);
  const [transitionCard, setTransitionCard] = useState(null);
  const [showCardContent, setShowCardContent] = useState(false);

  // Audio visualization state and refs
  const [audioScale, setAudioScale] = useState(0);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioContextRef = useRef(null);
  const recordingStreamRef = useRef(null);
  const playbackStreamRef = useRef(null);
  const animationFrameRef = useRef(null);
  const playbackAnimationFrameRef = useRef(null);

  // Track connected audio elements to prevent reconnection errors
  const connectedAudioElements = useRef(new WeakSet());
  
  // Load audio when current card changes
  useEffect(() => {
    if (currentCard) {
      console.log("Current card updated:", {
        id: currentCard.id,
        front_text: currentCard.front_text, 
        back_text: currentCard.back_text,
        front_lang: currentCard.front_lang,
        back_lang: currentCard.back_lang
      });

      const setupAudio = async (audioPath) => {
        if (!audioPath) return;
        
        // First load the audio
        await audio.loadAudio(audioPath);
        
        // Then ensure we have an audio context
        await ensureAudioContext();
        
        // Then create source connections right away instead of waiting for play
        const audioElement = audio.audioRefs.current.get(audioPath);
        if (audioElement && !window.audioSourceCache?.has(audioElement) && !connectedAudioElements.current.has(audioElement)) {
          try {
            console.log('Proactively creating audio source for:', audioPath);
            // Create a MediaElementAudioSourceNode
            const source = audioContextRef.current.createMediaElementSource(audioElement);
            // Connect to destination to hear the audio
            source.connect(audioContextRef.current.destination);
            
            // Create a MediaStream from the audio context for visualization
            const destination = audioContextRef.current.createMediaStreamDestination();
            source.connect(destination);
            
            // Mark this element as connected in both local and global caches
            connectedAudioElements.current.add(audioElement);
            if (window.audioSourceCache) {
              window.audioSourceCache.set(audioElement, { source, destination });
              console.log('Proactively added to global audioSourceCache:', audioPath);
            }
          } catch (error) {
            console.error('Error setting up proactive audio connection:', error, 'for path:', audioPath);
          }
        }
      };

      // Load front audio
      if (currentCard.front_audio_path) {
        setupAudio(currentCard.front_audio_path);
      }

      // Load back audio
      if (currentCard.back_audio_path) {
        setupAudio(currentCard.back_audio_path);
      }
    }
  }, [currentCardId]);

  // Create a global cache of audio sources to prevent reconnection errors
  useEffect(() => {
    // Create a cache on the window object if it doesn't exist
    if (!window.audioSourceCache) {
      window.audioSourceCache = new WeakMap();
      console.log("Created new global audioSourceCache");
    } else {
      console.log("Using existing audioSourceCache");
    }
    
    // Cleanup on unmount
    return () => {
      // No cleanup needed for WeakMap as it will be garbage collected 
      // when audio elements are no longer referenced
      console.log("ReviewMode unmounted, audioSourceCache remains for reuse");
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
      if (audio.isRecording) {
        try {
          // Get user media stream for visualization
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          
          // If we have an existing stream, disconnect and clean it up first
          if (recordingStreamRef.current) {
            recordingStreamRef.current.getTracks().forEach(track => track.stop());
          }
          
          // Set the new stream
          recordingStreamRef.current = stream;
          setIsRecording(true);
        } catch (error) {
          console.error('Error getting microphone stream for visualization:', error);
        }
      } else {
        // When we stop recording
        setIsRecording(false);
        
        // Don't actually stop the stream immediately, as this might cause issues with the recorded audio
        // We'll let the cleanup effect handle this when appropriate
      }
    };

    setupRecordingStream();
  }, [audio.isRecording]);

  // Track audio playback state
  useEffect(() => {
    const setupPlaybackListeners = () => {
      const listeners = new Map();
      const audioSources = new Map();
      
      // Find all audio elements from audio context
      audio.audioRefs.current.forEach((audioElement, path) => {
        // Check global cache first
        if (window.audioSourceCache && window.audioSourceCache.has(audioElement)) {
          console.log('Audio element found in global cache, reusing:', path);
          const { source, destination } = window.audioSourceCache.get(audioElement);
          audioSources.set(audioElement, { source, destination });
        } 
        // If not in global cache and not connected, create new source
        else if (!connectedAudioElements.current.has(audioElement) && audioContextRef.current) {
          try {
            console.log('Creating new audio source for:', path);
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
              console.log('Added to global audioSourceCache:', path);
            }
            console.log('Connected new audio element:', path);
          } catch (error) {
            console.error('Error setting up audio visualization for playback:', error, 'for path:', path);
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
            console.log('Playback stream set:', !!playbackStreamRef.current, 'destination:', !!sourceInfo.destination);
          } else {
            console.warn('No sourceInfo found for audio element:', path);
          }
        };
        
        // Create ended handler
        const endedHandler = () => {
          console.log('Audio ended:', path);
          
          // Don't immediately stop the visualization, let it decay
          // but track that playback has ended
          setTimeout(() => {
            setIsPlayingAudio(false);
            // Small delay before clearing the stream to allow for decay visualization to complete
            setTimeout(() => {
              if (!isPlayingAudio) {
                playbackStreamRef.current = null;
              }
            }, 1500); // Longer delay to allow for decay animation
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
      if (audio.evaluationAudioRef.current) {
        // Check global cache first
        if (window.audioSourceCache && window.audioSourceCache.has(audio.evaluationAudioRef.current)) {
          console.log('Evaluation audio element found in global cache, reusing');
          const { source, destination } = window.audioSourceCache.get(audio.evaluationAudioRef.current);
          audioSources.set(audio.evaluationAudioRef.current, { source, destination });
        }
        // If not in global cache and not already connected
        else if (!connectedAudioElements.current.has(audio.evaluationAudioRef.current) && audioContextRef.current) {
          try {
            const source = audioContextRef.current.createMediaElementSource(audio.evaluationAudioRef.current);
            source.connect(audioContextRef.current.destination);
            
            const destination = audioContextRef.current.createMediaStreamDestination();
            source.connect(destination);
            
            audioSources.set(audio.evaluationAudioRef.current, { source, destination });
            
            // Mark this element as connected in both local and global caches
            connectedAudioElements.current.add(audio.evaluationAudioRef.current);
            if (window.audioSourceCache) {
              window.audioSourceCache.set(audio.evaluationAudioRef.current, { source, destination });
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
          const sourceInfo = window.audioSourceCache?.get(audio.evaluationAudioRef.current) || 
                            audioSources.get(audio.evaluationAudioRef.current);
          if (sourceInfo) {
            playbackStreamRef.current = sourceInfo.destination.stream;
            console.log('Evaluation playback stream set');
          }
        };
        
        const evalEndedHandler = () => {
          console.log('Evaluation audio ended');
          
          // Don't immediately stop the visualization, let it decay
          // but track that playback has ended
          setTimeout(() => {
            setIsPlayingAudio(false);
            // Small delay before clearing the stream to allow for decay visualization to complete
            setTimeout(() => {
              if (!isPlayingAudio) {
                playbackStreamRef.current = null;
              }
            }, 1500); // Longer delay to allow for decay animation
          }, 100);
        };
        
        listeners.set(audio.evaluationAudioRef.current, { 
          playHandler: evalPlayHandler, 
          endedHandler: evalEndedHandler 
        });
        
        // Remove existing listeners to prevent duplicates
        audio.evaluationAudioRef.current.removeEventListener('play', evalPlayHandler);
        audio.evaluationAudioRef.current.removeEventListener('ended', evalEndedHandler);
        
        // Add event listeners
        audio.evaluationAudioRef.current.addEventListener('play', evalPlayHandler);
        audio.evaluationAudioRef.current.addEventListener('ended', evalEndedHandler);
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
  }, [audio.audioRefs.current.size]);

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

  // Update the play button click handler
  const handlePlayButtonClick = async (audioPath) => {
    try {
      console.log("Play button clicked for path:", audioPath);
      await ensureAudioContext();
      console.log("Audio context ready, state:", audioContextRef.current.state);
      
      // Get the audio element and ensure it has a source before playing
      const audioElement = audio.audioRefs.current.get(audioPath);
      if (audioElement) {
        // Check if this element has a source in the cache
        let sourceInfo = window.audioSourceCache?.get(audioElement);
        
        // If no source info found, try to create it now
        if (!sourceInfo && audioContextRef.current && !connectedAudioElements.current.has(audioElement)) {
          try {
            console.log('Creating audio source on demand for:', audioPath);
            // Create source connections
            const source = audioContextRef.current.createMediaElementSource(audioElement);
            source.connect(audioContextRef.current.destination);
            
            const destination = audioContextRef.current.createMediaStreamDestination();
            source.connect(destination);
            
            // Store in caches
            sourceInfo = { source, destination };
            connectedAudioElements.current.add(audioElement);
            if (window.audioSourceCache) {
              window.audioSourceCache.set(audioElement, sourceInfo);
              console.log('Added to global audioSourceCache on demand:', audioPath);
            }
          } catch (error) {
            console.error('Error creating audio source on demand:', error);
          }
        }
        
        if (sourceInfo && sourceInfo.destination) {
          // Pre-set the playback stream before playing
          playbackStreamRef.current = sourceInfo.destination.stream;
          console.log("Playback stream set proactively:", !!playbackStreamRef.current);
          
          // Trigger play, wait a moment for the event to fire
          audio.playAudio(audioPath);
          
          // Force set isPlayingAudio to true to make visualizer active
          setTimeout(() => {
            setIsPlayingAudio(true);
          }, 50);
        } else {
          console.warn("No sourceInfo found for this audio before playing");
          audio.playAudio(audioPath);
        }
      } else {
        console.warn("Audio element not found for path:", audioPath);
        audio.playAudio(audioPath);
      }
      
      console.log("Play audio called, playbackStreamRef.current:", !!playbackStreamRef.current);
    } catch (error) {
      console.error("Error playing audio:", error);
    }
  };

  // Update the record button click handler
  const handleRecordButtonClick = async () => {
    try {
      await ensureAudioContext();
      if (audio.isRecording) {
        const audioBlob = await audio.stopRecording();
        if (!audioBlob) return;
        setIsEvaluating(true);
        
        // Make sure currentCard is still available
        if (!currentCard) {
          setIsEvaluating(false);
          console.error("Current card is not available for evaluation");
          return;
        }
        
        // Debug: Log card details before evaluation
        console.log("Evaluating speech with card:", {
          id: currentCard.id,
          front_text: currentCard.front_text,
          back_text: currentCard.back_text,
          front_lang: currentCard.front_lang,
          back_lang: currentCard.back_lang,
          has_front_audio: !!currentCard.front_audio_path,
          has_back_audio: !!currentCard.back_audio_path
        });
        
        // Ensure all required properties are present before evaluation
        if (!currentCard.back_lang || !currentCard.front_lang) {
          console.error("Missing language information on card:", 
            { back_lang: currentCard.back_lang, front_lang: currentCard.front_lang });
        }
        
        await evaluateSpeech(audioBlob, currentCard);
        setIsEvaluating(false);
      } else {
        audio.startRecording();
      }
    } catch (error) {
      console.error("Error with recording:", error);
      setIsEvaluating(false);
    }
  };

  const handleEvaluationResult = useCallback((data) => {
    if (!data || !currentCard) {
      console.error("Invalid evaluation result or missing current card");
      return;
    }

    console.log("Received evaluation result:", data);
    
    review.setEvaluationResult(data);

    // Simplified quality system - only correct/incorrect
    const quality = data.result === 'correct' ? 'correct' : 'incorrect';

    // Update card scheduling based on result
    if (data.result === 'correct') {
      const cardToTransition = {...currentCard};
      setTransitionCard(cardToTransition);
      setIsTransitioning(true);
      review.setShowAnswer(true);
      
      // Set initial countdown value (3 seconds)
      setTransitionTimeLeft(3);
      
      // Clear any existing timer
      if (transitionTimerRef.current) {
        clearInterval(transitionTimerRef.current);
      }
      
      // Start countdown timer
      transitionTimerRef.current = setInterval(() => {
        setTransitionTimeLeft(prev => {
          if (prev <= 1) {
            // When timer reaches 0, clear interval and move to next card
            clearInterval(transitionTimerRef.current);
            
            // Use setTimeout to ensure state updates happen outside render cycle
            setTimeout(() => {
              review.setEvaluationResult(null);
              review.markCorrectGetNext();
              setIsTransitioning(false);
            }, 0);
            
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else if (data.result === 'incorrect') {
      // Use setTimeout to move state updates outside render cycle
      setTimeout(() => {
        review.markIncorrectGetNext();
      }, 0);
    }

    // Play evaluation audio if available
    if (data.audio) {
      const audioData = new Uint8Array(data.audio);
      const blob = new Blob([audioData], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      audio.evaluationAudioRef.current.src = url;
      audio.evaluationAudioRef.current.play()

      // Clean up the URL when audio ends
      audio.evaluationAudioRef.current.onended = () => {
        URL.revokeObjectURL(url);
      };
    }

    if (data.result === 'quit') {
      review.setShowAnswer(true);
      setTransitionTimeLeft(1);
      
      // Clear any existing timer
      if (transitionTimerRef.current) {
        clearInterval(transitionTimerRef.current);
      }
      
      setTimeout(() => {
        review.setEvaluationResult(null);
        review.moveToNextCard();
      }, 500); // Quick skip for quit commands
    } else if (data.result === 'incorrect') {
      // Incorrect answer
      review.setAttempts(prev => {
        const newAttempts = prev + 1;
        if (newAttempts >= 3) {
          review.setShowAnswer(true);
          
          // Clear any existing timer
          if (transitionTimerRef.current) {
            clearInterval(transitionTimerRef.current);
          }
          
          setTimeout(() => {
            review.setEvaluationResult(null);
            review.moveToNextCard();
          }, 2000);
        }
        return newAttempts;
      });
    }
  }, [currentCard, review]);

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: handleEvaluationResult
  });

  // Store current card in state when transitioning to prevent reference issues
  useEffect(() => {
    if (isTransitioning && currentCard && !transitionCard) {
      setTransitionCard({...currentCard});
    } else if (!isTransitioning) {
      setTransitionCard(null);
    }
  }, [isTransitioning, currentCard, transitionCard]);

  const handleBackToList = () => {
    navigate('/decks');
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearInterval(transitionTimerRef.current);
      }
    };
  }, []);

  if (!currentCard) {
    return (
      <div className="review-complete">
        <h3>🎉 Review Complete!</h3>
        <p>You've reviewed all due cards in this deck.</p>
        <button onClick={handleBackToList} className="back-btn">
          Back to Decks
        </button>
      </div>
    );
  }

  return (
    <div className="review-mode" style={{ display: 'flex', flex: 1, height: '100%', flexDirection: 'column', alignItems: 'center' }}>
      <div className="mode-header">
        <button onClick={handleBackToList} className="back-btn">
          ← Back to Decks
        </button>
        <h2>Reviewing: {decks[currentDeckId].name}</h2>
        <div className="card-toggle-container">
          <button 
            className={`card-toggle-button ${showCardContent ? 'active' : ''}`}
            onClick={() => setShowCardContent(!showCardContent)}
          >
            {showCardContent ? 'Hide Card' : 'Show Card'}
          </button>
        </div>
      </div>

      <div className="card-progress">
        {`New Cards: ${newCardsCount} • Review Cards: ${reviewCardsCount} • Learning Cards: ${learningCardsCount}`}
      </div>

      <div className="review-controls">
        <div className="attempts-counter">
          Attempts: {attempts}/3
        </div>

        {isEvaluating ? (
          <div className="evaluation-loading">Evaluating your speech...</div>
        ) : (
          <EvaluationResult result={evaluationResult} />
        )}
      </div>

      <div className="audio-controls-container">
        <div className="audio-control-column">
          <div className="audio-button-container">
            <div className="visualizer-container">
              <RadialAudioVisualizer
                audioStream={playbackStreamRef.current}
                isLive={isPlayingAudio}
                isAiOutput={true}
                audioContextRef={audioContextRef}
                animationFrameRef={playbackAnimationFrameRef}
              />
            </div>
            <button
              className={`audio-button play-button ${isPlayingAudio ? 'playing' : ''}`}
              onClick={() => handlePlayButtonClick(currentCard.front_audio_path)}
            >
              <div className="button-inner">
                <PlayIcon className="button-icon" />
              </div>
            </button>
            {(isTransitioning || showCardContent) && (transitionCard || currentCard) && (
              <div className="text-content">{transitionCard ? transitionCard.front_text : currentCard.front_text}</div>
            )}
          </div>
        </div>

        <div className="audio-control-column">
          <div className="audio-button-container">
            <div className="visualizer-container">
              <RadialAudioVisualizer
                audioStream={recordingStreamRef.current}
                isLive={isRecording}
                isAiOutput={false}
                audioContextRef={audioContextRef}
                animationFrameRef={animationFrameRef}
                onVolumeChange={setAudioScale}
              />
            </div>
            <button
              className={`audio-button mic-button ${isRecording ? 'recording' : ''} ${audio.isLoading || isEvaluating ? 'loading' : ''}`}
              onClick={handleRecordButtonClick}
              disabled={showAnswer || audio.isLoading || isEvaluating}
            >
              <div className="button-inner">
                <MicrophoneIcon className="button-icon" />
              </div>
              {isEvaluating && <div className="loading-spinner"></div>}
            </button>
            {(isTransitioning || (showCardContent && showAnswer)) && (transitionCard || currentCard) && (
              <div className="text-content">{transitionCard ? transitionCard.back_text : currentCard.back_text}</div>
            )}
          </div>
        </div>
      </div>
      
      {isTransitioning && (
        <div className="transition-timer-container">
          <div className="transition-timer">
            Next card in {transitionTimeLeft} {transitionTimeLeft === 1 ? 'second' : 'seconds'}
          </div>
        </div>
      )}
    </div>
  );
};

export default ReviewMode; 