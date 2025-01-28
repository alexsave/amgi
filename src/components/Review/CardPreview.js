import React from 'react';

const CardPreview = ({ currentCard, showAnswer, audio }) => {
  return (
    <div className="review-card">
      <div className="card-side">
        <h3>Front</h3>
        <p>{currentCard.frontText}</p>
        <small>{currentCard.frontPronunciation}</small>
        <button
          className="play-audio-btn"
          onClick={() => audio.playAudio('front', currentCard.frontAudioId)}
        >
          Play Audio
        </button>
      </div>

      {showAnswer && (
        <div className="card-side">
          <h3>Back</h3>
          <p>{currentCard.backText}</p>
          <small>{currentCard.backPronunciation}</small>
          <button
            className="play-audio-btn"
            onClick={() => audio.playAudio('back', currentCard.backAudioId)}
          >
            Play Audio
          </button>
        </div>
      )}
    </div>
  );
};

export default CardPreview; 