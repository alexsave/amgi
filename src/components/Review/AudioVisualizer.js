import React, { useEffect, useRef } from 'react';
import './AudioVisualizer.css';

const AudioVisualizer = ({ 
  audioStream, 
  isRecording, 
  isSpeaking, 
  isAiOutput,
  canvasRef,
  audioContextRef,
  analyserRef,
  animationFrameRef,
  onVolumeChange
}) => {
  const setupAudioVisualization = () => {
    if (!audioStream) return;

    console.log(`Setting up ${isAiOutput ? 'AI' : 'user'} audio visualization`);
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
      console.log('Created new AudioContext');
    }
    
    // Create or get the appropriate analyser
    if (!analyserRef.current) {
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;
      console.log(`Created new AnalyserNode for ${isAiOutput ? 'AI' : 'user'} with fftSize:`, analyserRef.current.fftSize);
    }

    // Create new source for visualization
    const source = audioContextRef.current.createMediaStreamSource(audioStream);
    source.connect(analyserRef.current);
    console.log(`Connected ${isAiOutput ? 'AI' : 'user'} audio source to analyser`);

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

    const bufferLength = analyserRef.current.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const WIDTH = rect.width;
    const HEIGHT = rect.height;
    const barWidth = (WIDTH / bufferLength) * 2.5;
    const barSpacing = 2;

    let frameCount = 0;
    const renderFrame = () => {
      if (!analyserRef.current || !ctx) {
        console.error(`Missing ${isAiOutput ? 'AI' : 'user'} analyser or canvas context`);
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
          if (!isAiOutput && isRecording) {
            // Rainbow gradient for user recording
            const hue = (i / bufferLength) * 360;
            const lightness = 50 + (barHeight / HEIGHT) * 50;
            ctx.fillStyle = `hsl(${hue}, 100%, ${lightness}%)`;
          } else if (isAiOutput && isSpeaking) {
            // Flame orange for AI speaking
            const intensity = barHeight / HEIGHT;
            ctx.fillStyle = `rgba(255, 107, 53, ${0.5 + intensity * 0.5})`;
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

      frameCount++;
      
      // Store animation frame reference
      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    renderFrame();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      source.disconnect();
    };
  };

  useEffect(() => {
    const cleanup = setupAudioVisualization();
    return () => {
      if (cleanup) cleanup();
    };
  }, [audioStream, isRecording, isSpeaking]);

  return (
    <canvas ref={canvasRef} className="audio-canvas" />
  );
};

export default AudioVisualizer; 