import React, { useEffect, useRef } from 'react';
import { useAudio } from '../../contexts/useAudio';
import './AudioVisualizer.css';

const RadialAudioVisualizer = ({ 
  visualizerType, // 'front', 'hint', or 'user'
  isActive = false, // Whether this specific visualizer should be active
}) => {
  const audio = useAudio();
  const analyserRef = useRef(null);
  const canvasRef = useRef(null);
  const sourceRef = useRef(null);
  const isAnimatingRef = useRef(false);
  const isDecayingRef = useRef(false);
  const lastDataRef = useRef(null);
  const decayFactorRef = useRef(0.9); // Controls how quickly the visualization decays
  const cleanupTimeoutRef = useRef(null);
  const previousStreamRef = useRef(null);
  
  // Determine properties based on visualizer type
  const isFrontAudio = visualizerType === 'front';
  const isHintAudio = visualizerType === 'hint';
  const isUserAudio = visualizerType === 'user';
  const isAiOutput = isFrontAudio || isHintAudio;
  
  // Get the appropriate stream based on visualizer type
  const audioStream = isAiOutput ? audio.playbackStreamRef.current : audio.recordingStreamRef.current;
  
  // Determine if this visualizer should be live based on both the audio context state AND the isActive prop
  const isLive = isUserAudio ? audio.isRecording : (audio.isPlayingAudio && isActive);
  
  // The requestAnimationFrame handle belongs to this component: it is the only
  // thing that schedules and cancels these frames, and it cleans them up on
  // unmount below.
  const animationFrameRef = useRef(null);

  // Direct reference to recording status 
  const isRecording = isUserAudio && audio.isRecording;
  
  const startAnimation = () => {
    if (isAnimatingRef.current) return;
    
    if (!analyserRef.current && !isDecayingRef.current) {
      if (!sourceRef.current || !canvasRef.current) {
        return;
      }
    }

    isAnimatingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const bufferLength = analyserRef.current ? analyserRef.current.frequencyBinCount : 128;
    let dataArray = new Uint8Array(bufferLength);
    
    // Initialize lastDataRef if needed
    if (!lastDataRef.current) {
      lastDataRef.current = new Uint8Array(bufferLength);
    }
    
    // Get the CSS dimensions (the display size)
    const rect = canvasRef.current.getBoundingClientRect();
    const displayWidth = rect.width;
    const displayHeight = rect.height;
    
    // Calculate center point based on display dimensions
    const centerX = displayWidth / 2;
    const centerY = displayHeight / 2;
    
    // Maximum length for the rays (based on display size)
    const maxRayLength = Math.min(displayWidth, displayHeight) * 0.8;
    
    // Define the angle range for the visualization (full circle)
    const startAngle = 0;
    const endAngle = 2 * Math.PI;
    const totalAngle = endAngle - startAngle;
    
    // Number of rays to render
    const visibleBars = Math.floor(bufferLength * 0.5);
    
    // Angular width between rays
    const barWidth = totalAngle / visibleBars;

    const renderFrame = () => {
      if (!isAnimatingRef.current) return;

      try {
        // Get data if we have an active analyser
        if (analyserRef.current && !isDecayingRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          // Save the current data for decay mode
          lastDataRef.current.set(dataArray);
        } 
        // If we're in decay mode, gradually reduce the values
        else if (isDecayingRef.current && lastDataRef.current) {
          let stillDecaying = false;
          // Create a new array for this frame's decayed values
          dataArray = new Uint8Array(lastDataRef.current.length);
          
          // Apply decay factor to each value
          for (let i = 0; i < lastDataRef.current.length; i++) {
            dataArray[i] = lastDataRef.current[i] * decayFactorRef.current;
            // Update the stored value for next frame
            lastDataRef.current[i] = dataArray[i];
            // Check if we should continue decaying
            if (dataArray[i] > 0.5) {
              stillDecaying = true;
            }
          }
          
          // If all values are effectively zero, stop decaying
          if (!stillDecaying) {
            isDecayingRef.current = false;
            isAnimatingRef.current = false;
            return;
          }
        }

        // Calculate average for visualization
        //let sum = 0;
        let hasSound = false;
        for (let i = 0; i < dataArray.length; i++) {
          //sum += dataArray[i];
          if (dataArray[i] > 5) { // Threshold to detect actual sound vs noise
            hasSound = true;
          }
        }
        //const average = sum / dataArray.length;
        //const volume = Math.min(average / 128, 1);

        // Clear the entire canvas using actual canvas dimensions
        ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);

        // Draw rays from center
        for (let i = 0; i < visibleBars; i++) {
          // Get data from the buffer (we'll sample evenly)
          const dataIndex = Math.floor(i * (dataArray.length / visibleBars));
          // Calculate normalized ray length (0 to 1)
          const rayLengthNormalized = Math.min(dataArray[dataIndex] / 255.0, 1);
          // Calculate actual ray length
          const rayLength = rayLengthNormalized * maxRayLength;
          
          // Calculate the angle for this ray
          const angle = startAngle + i * barWidth;
          
          // For cleaner visualization, skip drawing very short rays
          if (rayLength < maxRayLength * 0.05) continue;
          
          // Calculate end point for the ray (start point is center)
          const endX = centerX + Math.cos(angle) * rayLength;
          const endY = centerY + Math.sin(angle) * rayLength;
          
          // Set color based on state and sound detection
          if (hasSound || isDecayingRef.current) {
            if (isLive || isDecayingRef.current) {
              if (isFrontAudio) {
                // Green-teal gradient for front audio
                const hue = 140 + (rayLengthNormalized * 40); // Range 140-180 (green to teal)
                const saturation = 70 + (rayLengthNormalized * 30); // 70-100%
                const lightness = 40 + (rayLengthNormalized * 30); // 40-70%
                ctx.strokeStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
              } else if (isHintAudio) {
                // Purple-blue gradient for hint audio
                const hue = 250 + (rayLengthNormalized * 30); // Range 250-280 (purple to blue)
                const saturation = 70 + (rayLengthNormalized * 30); // 70-100%
                const lightness = 40 + (rayLengthNormalized * 30); // 40-70%
                ctx.strokeStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
              } else {
                // Orange gradient for user recording (matching the theme)
                const intensity = rayLengthNormalized;
                ctx.strokeStyle = `rgba(255, ${107 + intensity * 40}, 53, ${0.7 + intensity * 0.3})`;
              }
            } else {
              // Default colors when not live
              const intensity = rayLengthNormalized;
              if (isFrontAudio) {
                ctx.strokeStyle = `rgba(80, 200, 120, ${0.4 + intensity * 0.6})`; // Green for front
              } else if (isHintAudio) {
                ctx.strokeStyle = `rgba(150, 100, 240, ${0.4 + intensity * 0.6})`; // Purple for hint
              } else {
                ctx.strokeStyle = `rgba(240, 100, 50, ${0.4 + intensity * 0.6})`; // Orange for user
              }
            }
          } else {
            // Very dim color when no sound
            ctx.strokeStyle = `rgba(100, 100, 100, 0.1)`;
          }
          
          // Set line width based on the level (higher levels get thicker lines)
          ctx.lineWidth = 4 + rayLengthNormalized * 4;
          
          // Draw the ray from center outward
          ctx.beginPath();
          ctx.moveTo(centerX, centerY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
        }

        animationFrameRef.current = requestAnimationFrame(renderFrame);
      } catch (error) {
        isAnimatingRef.current = false;
        isDecayingRef.current = false;
      }
    };

    renderFrame();
  };

  const stopAnimation = (withDecay = false) => {
    // Clear any existing cleanup timeout
    if (cleanupTimeoutRef.current) {
      clearTimeout(cleanupTimeoutRef.current);
      cleanupTimeoutRef.current = null;
    }
    
    if (withDecay && isAnimatingRef.current) {
      // Start decay mode instead of stopping immediately
      isDecayingRef.current = true;
      
      // Set a timeout to clean up resources after decay is likely complete
      cleanupTimeoutRef.current = setTimeout(() => {
        if (!isLive) {
          // Only fully stop if we're not supposed to be live anymore
          isAnimatingRef.current = false;
          isDecayingRef.current = false;
          if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
          }
        }
      }, 1500); // Allow enough time for decay animation to complete
    } else {
      // Stop immediately
      isAnimatingRef.current = false;
      isDecayingRef.current = false;
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    }
  };

  const setupAudioVisualization = () => {
    if (!audioStream) {
      
      // For user recording, double-check if there's a stream that wasn't picked up yet
      if (isUserAudio && isLive && audio.recordingStreamRef.current) {
        // Use the stream directly from the context instead
        const directStream = audio.recordingStreamRef.current;
        
        // Set up with this stream
        setupWithStream(directStream);
        return;
      }
      
      // Still set up the canvas for idle animation
      const canvas = canvasRef.current;
      if (canvas) {
        updateCanvasSize();
        
        // If we are supposed to be live or isLive was just set to true, show an idle animation
        if (isLive && !isAnimatingRef.current) {
          startIdleAnimation();
        }
      }
      return;
    }

    return setupWithStream(audioStream);
  };

  // Helper function to set up audio visualization with a given stream
  const setupWithStream = (stream) => {
    if (!stream) return;
    
    // If we're supposed to be live but not yet animating, we should try to start
    const shouldStartAnimation = isLive && !isAnimatingRef.current;

    // Clean up existing source if any
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch (err) {
      }
      sourceRef.current = null;
    }

    // The audio provider owns the AudioContext, so ask it to create/resume one
    // rather than constructing a second context behind its back. Creation is
    // synchronous, so the analyser below can use it on this same tick.
    audio.ensureAudioContext().catch(() => {});
    if (!audio.audioContextRef.current) {
      startIdleAnimation(); // Fall back to idle animation when there is no context
      return;
    }
    
    // Create or get the appropriate analyser
    if (!analyserRef.current && audio.audioContextRef.current) {
      try {
        analyserRef.current = audio.audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 256;
      } catch (err) {
        startIdleAnimation(); // Fall back to idle animation on error
        return;
      }
    }

    try {
      // Create new source for visualization
      if (audio.audioContextRef.current && stream) {
        sourceRef.current = audio.audioContextRef.current.createMediaStreamSource(stream);
        sourceRef.current.connect(analyserRef.current);
        
        // Start animation if this is an active stream and we should be live
        if (shouldStartAnimation) {
          // Delay slightly to ensure everything is connected
          setTimeout(() => {
            startAnimation();
          }, 50);
        }
      }
    } catch (error) {
      startIdleAnimation(); // Fall back to idle animation on error
      return;
    }

    // Set up canvas
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    
    // Update canvas size based on display size
    updateCanvasSize();

    // Start animation if we should be live
    if (isLive) {
      startAnimation();
    }

    return () => {
      stopAnimation();
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch (err) {
        }
        sourceRef.current = null;
      }
    };
  };

  // Helper function to update canvas size
  const updateCanvasSize = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    
    // Update the canvas size
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    
    // Scale the context to restore the coordinate system
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    
    // Set canvas CSS size explicitly to match getBoundingClientRect
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  };

  // Add a simple idle animation when no audio is available
  const startIdleAnimation = () => {
    if (isAnimatingRef.current) return;
    if (!canvasRef.current) return;
    
    isAnimatingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    
    // Get the CSS dimensions (the display size)
    const rect = canvasRef.current.getBoundingClientRect();
    const displayWidth = rect.width;
    const displayHeight = rect.height;
    
    // Calculate center point based on display dimensions
    const centerX = displayWidth / 2;
    const centerY = displayHeight / 2;
    
    // Maximum length for the rays
    const maxRayLength = Math.min(displayWidth, displayHeight) * 0.6; // Increased from 0.4
    
    // Number of rays to render
    const rayCount = 16; // Increased from 12
    
    // Animation state
    let animationPhase = 0;
    
    const renderIdleFrame = () => {
      if (!isAnimatingRef.current || !canvasRef.current) {
        return;
      }
      
      // Clear the canvas
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      
      // Update animation phase
      animationPhase += 0.03; // Faster animation
      
      // Draw rays
      for (let i = 0; i < rayCount; i++) {
        const angle = (i / rayCount) * Math.PI * 2;
        const pulse = Math.sin(animationPhase + i * 0.5) * 0.5 + 0.5;
        const rayLength = maxRayLength * (0.3 + pulse * 0.4); // Increased range
        
        const endX = centerX + Math.cos(angle) * rayLength;
        const endY = centerY + Math.sin(angle) * rayLength;
        
        // Set color based on type (front, hint, or user)
        const alpha = 0.4 + pulse * 0.3; // Increased alpha for better visibility
        if (isFrontAudio) {
          ctx.strokeStyle = `rgba(80, 200, 120, ${alpha})`; // Green for front
        } else if (isHintAudio) {
          ctx.strokeStyle = `rgba(150, 100, 240, ${alpha})`; // Purple for hint
        } else {
          ctx.strokeStyle = `rgba(240, 100, 50, ${alpha})`; // Orange for user
        }
        
        ctx.lineWidth = 3 + pulse * 3; // Increased line width
        
        // Draw the ray
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
      
      animationFrameRef.current = requestAnimationFrame(renderIdleFrame);
    };
    
    // Start the idle animation
    renderIdleFrame();
  };

  // Effect to handle the isActive prop changes
  useEffect(() => {
    // If this visualizer should be active but isn't animating
    if (isActive && !isAnimatingRef.current && !isDecayingRef.current) {
      if ((isUserAudio && audio.isRecording) || (isAiOutput && audio.isPlayingAudio)) {
        setupAudioVisualization();
      }
    } 
    // If this visualizer shouldn't be active but is still animating
    else if (!isActive && isAnimatingRef.current && !isDecayingRef.current && !isUserAudio) {
      stopAnimation(true); // Use decay effect when deactivating
    }
  }, [isActive, audio.isPlayingAudio, audio.isRecording]);

  // Effect specifically for recording state changes
  useEffect(() => {
    if (isUserAudio && isRecording) {
      // Force re-setup of visualization when recording starts
      if (audio.recordingStreamRef.current) {
        // Stop any existing animation first
        if (isAnimatingRef.current) {
          stopAnimation();
        }
        // Set up with the new stream
        setupAudioVisualization();
      }
    }
  }, [isRecording, audio.recordingStreamRef.current]);

  // Effect to handle animation state changes
  useEffect(() => {
    
    // If we should be live but aren't animating
    if (isLive && !isAnimatingRef.current && !isDecayingRef.current) {
      if (sourceRef.current && analyserRef.current) {
        startAnimation();
      } else if (audioStream) {
        // If we have a stream but no source, try to set it up again
        setupAudioVisualization();
      } else {
        // If we don't have a stream at all, show idle animation
        startIdleAnimation();
      }
    } 
    // If we shouldn't be live but are still animating and not already decaying
    else if (!isLive && isAnimatingRef.current && !isDecayingRef.current) {
      stopAnimation(true); // Use decay effect
    }
  }, [isLive, isFrontAudio, isHintAudio, audioStream]);

  // Effect to start idle animation on initial mount if no stream
  useEffect(() => {
    // If no audioStream is available on mount, start idle animation
    if (!audioStream && !isAnimatingRef.current) {
      updateCanvasSize();
      startIdleAnimation();
    }
  }, []);

  // Effect to handle audioStream changes
  useEffect(() => {
    
    // If we have a valid stream, force reset the visualization
    if (audioStream) {
      // Clean up existing resources first
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
          sourceRef.current = null;
        } catch (err) {
        }
      }
      
      // Stop current animation if any
      if (isAnimatingRef.current) {
        stopAnimation();
      }
      
      // Reset analyzer to ensure fresh setup
      analyserRef.current = null;
    }
    
    const cleanup = setupAudioVisualization();
    
    // Clean up function
    return () => {
      if (cleanup) cleanup();
    };
  }, [audioStream, isFrontAudio, isHintAudio]);

  // Add resize observer for canvas
  useEffect(() => {
    if (!canvasRef.current) return;
    
    const resizeObserver = new ResizeObserver(() => {
      updateCanvasSize();
      if (isAnimatingRef.current) {
        // Restart animation to use the new canvas size
        stopAnimation();
        startAnimation();
      }
    });
    
    resizeObserver.observe(canvasRef.current);
    
    return () => {
      if (canvasRef.current) {
        resizeObserver.unobserve(canvasRef.current);
      }
      resizeObserver.disconnect();
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, []);

  // Effect to track stream changes and handle stream cleanup
  useEffect(() => {
    // If we have a new stream, store the previous one for potential cleanup
    if (audioStream && previousStreamRef.current !== audioStream) {
      previousStreamRef.current = audioStream;
    }
    
    // If the stream is removed or changed, we need to handle cleanup
    return () => {
      // This will be executed when the component unmounts
      // or when audioStream changes (with stream becoming null)
      if (!audioStream && previousStreamRef.current) {
        
        // If we're still animating, use decay effect before stopping
        if (isAnimatingRef.current && !isDecayingRef.current) {
          stopAnimation(true);
        }
        
        // Clear the previous stream reference after we've handled the cleanup
        previousStreamRef.current = null;
      }
    };
  }, [audioStream, isFrontAudio, isHintAudio]);

  // Cleanup on prop changes (when isLive becomes false)
  useEffect(() => {
    if (!isLive && previousStreamRef.current) {
      // Schedule a cleanup after the decay animation finishes
      const cleanupDelay = 2000; // 2 seconds should be enough for decay to complete
      
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
      }
      
      cleanupTimeoutRef.current = setTimeout(() => {
        // The animation has had time to decay, now we can clean up the stream reference
        previousStreamRef.current = null;
      }, cleanupDelay);
    }
    
    return () => {
      if (cleanupTimeoutRef.current) {
        clearTimeout(cleanupTimeoutRef.current);
      }
    };
  }, [isLive, isFrontAudio, isHintAudio]);

  return (
    <canvas ref={canvasRef} className="audio-canvas" />
  );
};

export default RadialAudioVisualizer; 