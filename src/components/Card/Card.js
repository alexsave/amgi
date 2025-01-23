import React from 'react';
import { AUDIO_SIDES } from '../../utils/constants';
import './Card.css';

const Card = ({ 
  frontText, 
  backText, 
  sourceLang, 
  targetLang, 
  showBack = false,
  onPlayAudio 
}) => {
  return (
    <div className="flashcard">
      <div className="card-side">
        <h3>Front</h3>
        <p>{frontText}</p>
        {sourceLang && <small>Language: {sourceLang}</small>}
        <button 
          onClick={() => onPlayAudio(AUDIO_SIDES.FRONT)}
          className="play-audio-btn"
        >
          🔊 Play Audio
        </button>
      </div>
      {showBack && (
        <div className="card-side">
          <h3>Back</h3>
          <p>{backText}</p>
          {targetLang && <small>Language: {targetLang}</small>}
          <button 
            onClick={() => onPlayAudio(AUDIO_SIDES.BACK)}
            className="play-audio-btn"
          >
            🔊 Play Audio
          </button>
        </div>
      )}
    </div>
  );
};

export default Card; 