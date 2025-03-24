import React, { useEffect, useRef } from 'react';
import './AudioVisualizer.css';

const RadialAudioVisualizer = ({ 
  audioStream, 
  isLive,
  isAiOutput,
  audioContextRef,
  animationFrameRef,
  onVolumeChange
}) => {
  const analyserRef = useRef(null);
  const canvasRef = useRef(null);
  const sourceRef = useRef(null);
  const isAnimatingRef = useRef(false);
  const isDecayingRef = useRef(false);
  const lastDataRef = useRef(null);
  const decayFactorRef = useRef(0.9); // Controls how quickly the visualization decays

  const startAnimation = () => {
    if (isAnimatingRef.current) return;
    
    if (!analyserRef.current && !isDecayingRef.current) {
      if (!sourceRef.current || !canvasRef.current) {
        console.log(`Cannot start animation: analyser=${!!analyserRef.current}, source=${!!sourceRef.current}, canvas=${!!canvasRef.current}`);
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
            console.log(`Decay complete for ${isAiOutput ? 'AI' : 'user'} visualizer`);
            isDecayingRef.current = false;
            isAnimatingRef.current = false;
            return;
          }
        }

        // Calculate average for visualization
        let sum = 0;
        let hasSound = false;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
          if (dataArray[i] > 5) { // Threshold to detect actual sound vs noise
            hasSound = true;
          }
        }
        const average = sum / dataArray.length;
        const volume = Math.min(average / 128, 1);
        
        // Only update scale if there's actual sound and it's user audio
        if (hasSound && !isAiOutput && onVolumeChange) {
          onVolumeChange(volume * 100);
        }

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
              if (isAiOutput) {
                // Blue-cyan gradient for AI
                const hue = 195 + (rayLengthNormalized * 25); // Range 195-220 (cyan to blue)
                const saturation = 80 + (rayLengthNormalized * 20); // 80-100%
                const lightness = 45 + (rayLengthNormalized * 30); // 45-75%
                ctx.strokeStyle = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
              } else {
                // Orange gradient for user recording (matching the image)
                const intensity = rayLengthNormalized;
                ctx.strokeStyle = `rgba(255, ${107 + intensity * 40}, 53, ${0.7 + intensity * 0.3})`;
              }
            } else {
              // Default colors when not live
              const intensity = rayLengthNormalized;
              ctx.strokeStyle = isAiOutput 
                ? `rgba(80, 160, 240, ${0.4 + intensity * 0.6})` // Blue for AI
                : `rgba(240, 100, 50, ${0.4 + intensity * 0.6})`; // Orange for user
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
        console.error(`Error in render frame for ${isAiOutput ? 'AI' : 'user'}:`, error);
        isAnimatingRef.current = false;
        isDecayingRef.current = false;
      }
    };

    renderFrame();
  };

  const stopAnimation = (withDecay = false) => {
    if (withDecay && isAnimatingRef.current) {
      // Start decay mode instead of stopping immediately
      console.log(`Starting decay for ${isAiOutput ? 'AI' : 'user'} visualizer`);
      isDecayingRef.current = true;
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
      console.log(`No audioStream for ${isAiOutput ? 'AI' : 'user'} visualizer`);
      
      // Still set up the canvas for idle animation
      const canvas = canvasRef.current;
      if (canvas) {
        updateCanvasSize();
        
        // If we are supposed to be live, show an idle animation
        if (isLive && !isAnimatingRef.current) {
          startIdleAnimation();
        }
      }
      return;
    }

    console.log(`Setting up audioStream for ${isAiOutput ? 'AI' : 'user'} visualizer`, {
      streamActive: audioStream.active,
      streamId: audioStream.id,
      hasAudioTracks: audioStream.getAudioTracks().length > 0
    });
    
    // If we're supposed to be live but not yet animating, we should try to start
    const shouldStartAnimation = isLive && !isAnimatingRef.current;

    // Clean up existing source if any
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch (err) {
        console.warn('Error disconnecting source:', err);
      }
      sourceRef.current = null;
    }

    // Create or resume AudioContext
    if (!audioContextRef.current) {
      try {
        audioContextRef.current = new AudioContext();
      } catch (err) {
        console.error('Error creating AudioContext:', err);
        return;
      }
    } else if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(err => {
        console.error('Error resuming AudioContext:', err);
        return;
      });
    }
    
    // Create or get the appropriate analyser
    if (!analyserRef.current && audioContextRef.current) {
      try {
        analyserRef.current = audioContextRef.current.createAnalyser();
        analyserRef.current.fftSize = 256;
      } catch (err) {
        console.error('Error creating analyser:', err);
        return;
      }
    }

    try {
      // Create new source for visualization
      if (audioContextRef.current && audioStream) {
        sourceRef.current = audioContextRef.current.createMediaStreamSource(audioStream);
        sourceRef.current.connect(analyserRef.current);
        console.log(`Successfully connected stream to analyser for ${isAiOutput ? 'AI' : 'user'} visualizer`);
        
        // Start animation if this is an active stream and we should be live
        if (shouldStartAnimation) {
          console.log(`Auto-starting animation for ${isAiOutput ? 'AI' : 'user'} visualizer`);
          // Delay slightly to ensure everything is connected
          setTimeout(() => {
            startAnimation();
          }, 50);
        }
      }
    } catch (error) {
      console.error(`Error creating media stream source for ${isAiOutput ? 'AI' : 'user'}:`, error);
      return;
    }

    // Set up canvas
    const canvas = canvasRef.current;
    if (!canvas) {
      console.error(`${isAiOutput ? 'AI' : 'User'} canvas element not found`);
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
          console.warn('Error disconnecting source during cleanup:', err);
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
    const maxRayLength = Math.min(displayWidth, displayHeight) * 0.4;
    
    // Number of rays to render
    const rayCount = 12;
    
    // Animation state
    let animationPhase = 0;
    
    const renderIdleFrame = () => {
      if (!isAnimatingRef.current || !canvasRef.current) {
        return;
      }
      
      // Clear the canvas
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      
      // Update animation phase
      animationPhase += 0.02;
      
      // Draw rays
      for (let i = 0; i < rayCount; i++) {
        const angle = (i / rayCount) * Math.PI * 2;
        const pulse = Math.sin(animationPhase + i * 0.5) * 0.5 + 0.5;
        const rayLength = maxRayLength * (0.3 + pulse * 0.2);
        
        const endX = centerX + Math.cos(angle) * rayLength;
        const endY = centerY + Math.sin(angle) * rayLength;
        
        // Set color based on type (AI or user)
        const alpha = 0.2 + pulse * 0.1;
        ctx.strokeStyle = isAiOutput 
          ? `rgba(80, 160, 240, ${alpha})` // Blue for AI
          : `rgba(240, 100, 50, ${alpha})`; // Orange for user
        
        ctx.lineWidth = 2 + pulse * 2;
        
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
    console.log(`Started idle animation for ${isAiOutput ? 'AI' : 'user'} visualizer`);
  };

  // Effect to handle animation state changes
  useEffect(() => {
    console.log(`isLive changed to ${isLive} for ${isAiOutput ? 'AI' : 'user'} visualizer`, {
      hasStream: !!audioStream,
      hasSource: !!sourceRef.current,
      isAnimating: isAnimatingRef.current,
      hasAnalyser: !!analyserRef.current,
      isDecaying: isDecayingRef.current
    });
    
    // If we should be live but aren't animating
    if (isLive && !isAnimatingRef.current && !isDecayingRef.current) {
      if (sourceRef.current && analyserRef.current) {
        console.log(`Starting animation for ${isAiOutput ? 'AI' : 'user'} visualizer (isLive change)`);
        startAnimation();
      } else if (audioStream) {
        // If we have a stream but no source, try to set it up again
        console.log(`Re-setting up visualization for ${isAiOutput ? 'AI' : 'user'} visualizer`);
        setupAudioVisualization();
      } else {
        // If we don't have a stream at all, show idle animation
        console.log(`Starting idle animation for ${isAiOutput ? 'AI' : 'user'} visualizer (no stream)`);
        startIdleAnimation();
      }
    } 
    // If we shouldn't be live but are still animating and not already decaying
    else if (!isLive && isAnimatingRef.current && !isDecayingRef.current) {
      console.log(`Stopping animation with decay for ${isAiOutput ? 'AI' : 'user'} visualizer`);
      stopAnimation(true); // Use decay effect
    }
  }, [isLive, isAiOutput, audioStream]);

  // Effect to handle audioStream changes
  useEffect(() => {
    const cleanup = setupAudioVisualization();
    
    // Clean up function
    return () => {
      if (cleanup) cleanup();
    };
  }, [audioStream]);

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

  return (
    <canvas ref={canvasRef} className="audio-canvas" />
  );
};

export default RadialAudioVisualizer; 