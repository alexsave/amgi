import React from 'react';
import './RecordingControls.css';

const RecordingControls = ({
  isRecording,
  isLoading,
  showAnswer,
  onStartRecording,
  onStopRecording
}) => {
  return (
    <button
      onClick={isRecording ? onStopRecording : onStartRecording}
      className={`record-btn ${isRecording ? 'recording' : ''}`}
      disabled={showAnswer || isLoading}
    >
      {isLoading ? '⏳ Initializing...' : 
       isRecording ? '⬛ Stop Recording' : 
       '⚫ Start Recording'}
    </button>
  );
};

export default RecordingControls; 