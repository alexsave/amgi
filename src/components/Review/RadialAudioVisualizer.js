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

  const startAnimation = () => {
    if (isAnimatingRef.current) return;
    
    if (!analyserRef.current || !sourceRef.current || !canvasRef.current) {
      console.log(`Cannot start animation: analyser=${!!analyserRef.current}, source=${!!sourceRef.current}, canvas=${!!canvasRef.current}`);
      return;
    }

    isAnimatingRef.current = true;
    const ctx = canvasRef.current.getContext('2d');
    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
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
        // Always check if analyser still exists
        if (!analyserRef.current) {
          console.warn('Analyser was removed mid-animation');
          isAnimatingRef.current = false;
          return;
        }

        analyserRef.current.getByteFrequencyData(dataArray);

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
          const dataIndex = Math.floor(i * (bufferLength / visibleBars));
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
          if (hasSound) {
            if (isLive) {
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
      }
    };

    renderFrame();
  };

  const stopAnimation = () => {
    isAnimatingRef.current = false;
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  };

  const setupAudioVisualization = () => {
    if (!audioStream) {
      console.log(`No audioStream for ${isAiOutput ? 'AI' : 'user'} visualizer`);
      return;
    }

    console.log(`Setting up audioStream for ${isAiOutput ? 'AI' : 'user'} visualizer`);

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

  // Effect to handle animation state changes
  useEffect(() => {
    console.log(`isLive changed to ${isLive} for ${isAiOutput ? 'AI' : 'user'} visualizer`);
    
    if (isLive && !isAnimatingRef.current && sourceRef.current) {
      startAnimation();
    } else if (!isLive && isAnimatingRef.current) {
      stopAnimation();
    }
  }, [isLive, isAiOutput]);

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