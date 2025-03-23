import React, { useEffect, useRef } from 'react';
import './AudioVisualizer.css';

const AudioVisualizer = ({ 
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
    const WIDTH = canvasRef.current.width;
    const HEIGHT = canvasRef.current.height;
    
    // Calculate center point (assuming square canvas)
    const centerX = WIDTH / 2;
    const centerY = HEIGHT / 2;
    // Inner radius where the visualization starts (should match button size)
    const innerRadius = Math.min(WIDTH, HEIGHT) * 0.5;
    // Outer radius limit for the visualization
    const outerRadius = Math.min(WIDTH, HEIGHT) * 0.9;
    // Maximum length of each segment
    const maxBarLength = outerRadius - innerRadius;
    // Angular width of each segment in radians
    const barWidth = (2 * Math.PI) / bufferLength;

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

        // Clear the entire canvas
        ctx.clearRect(0, 0, WIDTH, HEIGHT);

        // Draw circular visualization
        for (let i = 0; i < bufferLength; i++) {
          // Calculate normalized bar height (0 to 1)
          const barHeightNormalized = Math.min(dataArray[i] / 255.0, 1);
          // Calculate actual bar length
          const barLength = barHeightNormalized * maxBarLength;
          
          // Calculate the angle for this segment (clockwise rotation)
          const angle = i * barWidth;
          
          // Calculate start and end points for the segment
          const startX = centerX + Math.cos(angle) * innerRadius;
          const startY = centerY + Math.sin(angle) * innerRadius;
          const endX = centerX + Math.cos(angle) * (innerRadius + barLength);
          const endY = centerY + Math.sin(angle) * (innerRadius + barLength);
          
          // Set color based on state and sound detection
          if (hasSound) {
            if (isLive) {
              if (isAiOutput) {
                // Rainbow gradient for AI speaking
                const hue = (i / bufferLength) * 360;
                const lightness = 50 + barHeightNormalized * 50;
                ctx.strokeStyle = `hsl(${hue}, 100%, ${lightness}%)`;
              } else {
                // Flame orange for user recording
                const intensity = barHeightNormalized;
                ctx.strokeStyle = `rgba(255, 107, 53, ${0.5 + intensity * 0.5})`;
              }
            } else {
              // Default colors
              const intensity = barHeightNormalized;
              ctx.strokeStyle = isAiOutput 
                ? `rgba(255, 107, 53, ${0.3 + intensity * 0.7})` // AI color
                : `rgba(100, 149, 237, ${0.3 + intensity * 0.7})`; // User color
            }
          } else {
            // Very dim color when no sound
            ctx.strokeStyle = `rgba(100, 100, 100, 0.1)`;
          }
          
          // Set line width based on the level (higher levels get thicker lines)
          ctx.lineWidth = 2 + barHeightNormalized * 2;
          
          // Draw the line segment
          ctx.beginPath();
          ctx.moveTo(startX, startY);
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
    
    // Set actual pixel dimensions
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Draw initial state - empty circle
    ctx.strokeStyle = `rgba(100, 100, 100, 0.1)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(rect.width / 2, rect.height / 2, Math.min(rect.width, rect.height) * 0.5, 0, 2 * Math.PI);
    ctx.stroke();

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
    
    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        const canvas = entry.target;
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
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

export default AudioVisualizer; 