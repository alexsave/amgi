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
      return;
    }

    // Clean up existing source if any
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    // Create or resume AudioContext
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    } else if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    
    // Create or get the appropriate analyser
    if (!analyserRef.current) {
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
    }

    try {
      // Create new source for visualization
      sourceRef.current = audioContextRef.current.createMediaStreamSource(audioStream);
      sourceRef.current.connect(analyserRef.current);
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

    // Start animation
    startAnimation();

    return () => {
      stopAnimation();
      if (sourceRef.current) {
        sourceRef.current.disconnect();
        sourceRef.current = null;
      }
    };
  };

  // Effect to handle animation state changes
  useEffect(() => {

    if (isLive && !isAnimatingRef.current && sourceRef.current) {
      startAnimation();
    } else if (!isLive && isAnimatingRef.current) {
      stopAnimation();
    }
  }, [isLive, isAiOutput]);

  useEffect(() => {
    const cleanup = setupAudioVisualization();
    return () => {
      if (cleanup) cleanup();
    };
  }, [audioStream]);

  return (
    <canvas ref={canvasRef} className="audio-canvas" />
  );
};

export default AudioVisualizer; 