import React from 'react';

const CardPreview = ({ currentCard, showAnswer, audio }) => {
  return (
    <div className="review-card">
      <div className="card-side">
        <h3>Front</h3>
        <p>{currentCard.front_text}</p>
        <small>{currentCard.frontPronunciation}</small>
        <button
          className="play-audio-btn"
          onClick={() => audio.playAudio(currentCard.front_audio_path)}
        >
          Play Audio
        </button>
      </div>

      {showAnswer && (
        <div className="card-side">
          <h3>Back</h3>
          <p>{currentCard.back_text}</p>
          <small>{currentCard.backPronunciation}</small>
          <button
            className="play-audio-btn"
            onClick={() => audio.playAudio(currentCard.back_audio_path)}
          >
            Play Audio
          </button>
        </div>
      )}
    </div>
  );
};

export default CardPreview; 