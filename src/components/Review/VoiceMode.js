import React from 'react';
import { MicrophoneIcon } from '@heroicons/react/24/solid';
import './VoiceMode.css';

const VoiceMode = ({ currentCard }) => {
  return (
    <div className="voice-mode">
      <div className="voice-interface">
        <MicrophoneIcon className="large-mic-icon" />
      </div>
    </div>
  );
};

export default VoiceMode; 