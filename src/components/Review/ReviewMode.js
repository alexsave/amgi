import React, { useState, useEffect, useRef } from 'react';
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
  const { currentCard, currentCardId, currentCardIdRef, attempts, showAnswer, evaluationResult, newCardsCount, reviewCardsCount, learningCardsCount } = review;

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
      // Load front audio
      if (currentCard.front_audio_path) {
        audio.loadAudio(currentCard.front_audio_path)
      }

      // Load back audio
      if (currentCard.back_audio_path) {
        audio.loadAudio(currentCard.back_audio_path)
      }
    }
  }, [currentCardId]);

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
          setIsPlayingAudio(false);
          setTimeout(() => {
            if (!isPlayingAudio) {
              playbackStreamRef.current = null;
            }
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
      await ensureAudioContext();
      audio.playAudio(audioPath);
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
        await evaluateSpeech(audioBlob, currentCard);
      } else {
        audio.startRecording();
      }
    } catch (error) {
      console.error("Error with recording:", error);
    }
  };

  const handleEvaluationResult = (data) => {
    if (!data || !currentCard) {
      return;
    }

    review.setEvaluationResult(data);

    // Simplified quality system - only correct/incorrect
    const quality = data.result === 'correct' ? 'correct' : 'incorrect';

    // Update card scheduling based on result
    if (data.result === 'correct') {
      review.markCorrectGetNext();
    } else if (data.result === 'incorrect') {
      review.markIncorrectGetNext();
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
      setTimeout(review.moveToNextCard, 500); // Quick skip for quit commands
    } else if (data.result === 'correct') {
      setTimeout(review.moveToNextCard, 2000); // 2 second delay for correct answers
    } else {
      // Incorrect answer
      review.setAttempts(prev => {
        const newAttempts = prev + 1;
        if (newAttempts >= 3) {
          review.setShowAnswer(true);
          setTimeout(review.moveToNextCard, 2000);
        }
        return newAttempts;
      });
    }
  };

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: handleEvaluationResult
  });

  const handleBackToList = () => {
    navigate('/decks');
  };

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
      </div>

      <div className="card-progress">
        {`New Cards: ${newCardsCount} • Review Cards: ${reviewCardsCount} • Learning Cards: ${learningCardsCount}`}
      </div>
      <div style={{ width: '100%', display: 'flex', flexDirection: 'row', justifyContent: 'space-evenly' }}>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div className="audio-button-container">
            <button
              className={`audio-button play-button ${isPlayingAudio ? 'playing' : ''}`}
              onClick={() => handlePlayButtonClick(currentCard.front_audio_path)}
            >
              <div className="button-inner">
                <PlayIcon className="button-icon" />
              </div>
            </button>
            <div className="visualizer-container">
              <RadialAudioVisualizer
                audioStream={playbackStreamRef.current}
                isLive={isPlayingAudio}
                isAiOutput={true}
                audioContextRef={audioContextRef}
                animationFrameRef={playbackAnimationFrameRef}
              />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
          <div className="audio-button-container">
            <button
              className={`audio-button mic-button ${isRecording ? 'recording' : ''} ${audio.isLoading ? 'loading' : ''}`}
              onClick={handleRecordButtonClick}
              disabled={showAnswer || audio.isLoading}
            >
              <div className="button-inner">
                <MicrophoneIcon className="button-icon" />
              </div>
            </button>
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
          </div>
        </div>
      </div>

      <div className="review-controls">
        <div className="attempts-counter">
          Attempts: {attempts}/3
        </div>

        <EvaluationResult result={evaluationResult} />
      </div>
    </div>
  );
};

export default ReviewMode; 