import React, { useEffect, useRef } from 'react';
import './AudioVisualizer.css';

const RectangleAudioVisualizer = ({ 
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
    const barWidth = (WIDTH / bufferLength) * 2.5;
    const barSpacing = 2;

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

        // Draw bar visualization
        ctx.clearRect(0, 0, WIDTH, HEIGHT);

        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255.0) * HEIGHT * 0.8;
          
          // Set color based on state and sound detection
          if (hasSound) {
            if (isLive) {
              if (isAiOutput) {
                // Rainbow gradient for AI speaking
                const hue = (i / bufferLength) * 360;
                const lightness = 50 + (barHeight / HEIGHT) * 50;
                ctx.fillStyle = `hsl(${hue}, 100%, ${lightness}%)`;
              } else {
                // Flame orange for user recording
                const intensity = barHeight / HEIGHT;
                ctx.fillStyle = `rgba(255, 107, 53, ${0.5 + intensity * 0.5})`;
              }
            } else {
              // Default colors
              const intensity = barHeight / HEIGHT;
              ctx.fillStyle = isAiOutput 
                ? `rgba(255, 107, 53, ${0.3 + intensity * 0.3})` // AI color
                : `rgba(100, 149, 237, ${0.3 + intensity * 0.3})`; // User color
            }
          } else {
            // Very dim color when no sound
            ctx.fillStyle = `rgba(100, 100, 100, 0.1)`;
          }

          // Draw bar with rounded corners
          const barX = x + barSpacing;
          const barY = HEIGHT - barHeight;
          const barW = barWidth - barSpacing * 2;
          const radius = Math.min(barW / 2, barHeight / 2, 4);

          ctx.beginPath();
          ctx.moveTo(barX + radius, barY);
          ctx.lineTo(barX + barW - radius, barY);
          ctx.quadraticCurveTo(barX + barW, barY, barX + barW, barY + radius);
          ctx.lineTo(barX + barW, HEIGHT - radius);
          ctx.quadraticCurveTo(barX + barW, HEIGHT, barX + barW - radius, HEIGHT);
          ctx.lineTo(barX + radius, HEIGHT);
          ctx.quadraticCurveTo(barX, HEIGHT, barX, HEIGHT - radius);
          ctx.lineTo(barX, barY + radius);
          ctx.quadraticCurveTo(barX, barY, barX + radius, barY);
          ctx.closePath();
          
          ctx.fill();
          
          x += barWidth;
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

    // Draw initial state
    ctx.fillStyle = `rgba(100, 100, 100, 0.1)`;
    ctx.fillRect(0, 0, rect.width, rect.height);

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
    <canvas ref={canvasRef} className="audio-canvas rectangle" />
  );
};

export default RectangleAudioVisualizer; 