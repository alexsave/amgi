import React, { useEffect, useRef } from 'react';
import './AudioVisualizer.css';
import RadialAudioVisualizer from './RadialAudioVisualizer';
import RectangleAudioVisualizer from './RectangleAudioVisualizer';

const AudioVisualizer = (props) => {
  const { visualizerType = 'radial', ...otherProps } = props;
  
  if (visualizerType === 'rectangle') {
    return <RectangleAudioVisualizer {...otherProps} />;
  }
  
  // Default to radial visualizer
  return <RadialAudioVisualizer {...otherProps} />;
};

export default AudioVisualizer; 