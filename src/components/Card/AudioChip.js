import React, { useEffect, useRef, useState } from 'react';
import { ankiApi } from '../../utils/ankiApi';
import './AudioChip.css';

// One audio control, used wherever a clip can be played.
//
// It carries its own language name because the alternative, two bare play
// circles side by side, cannot say which is which - and a caption under each
// one turns two buttons into a four-line block. The name is the label.
//
// The bytes are fetched on first press, not on render: a deck page lists
// twenty notes with two clips each, and pre-loading forty files to play none
// of them is forty requests for nothing.

const AudioChip = ({ filename, label, tone = 'cue' }) => {
  const [state, setState] = useState('idle');
  const audioRef = useRef(null);
  const urlRef = useRef(null);

  useEffect(() => () => {
    if (audioRef.current) audioRef.current.pause();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  if (!filename) return null;

  const play = async () => {
    try {
      if (!urlRef.current) {
        setState('loading');
        const blob = await ankiApi.mediaBlob(filename);
        urlRef.current = URL.createObjectURL(blob);
        audioRef.current = new Audio(urlRef.current);
        audioRef.current.addEventListener('ended', () => setState('idle'));
      }
      audioRef.current.currentTime = 0;
      setState('playing');
      await audioRef.current.play();
    } catch {
      setState('error');
    }
  };

  return (
    <button
      type="button"
      className={`audio-chip audio-chip-${tone} ${state === 'playing' ? 'is-playing' : ''}`}
      onClick={play}
      disabled={state === 'loading'}
      title={state === 'error' ? 'That clip could not be loaded' : `Play the ${label} recording`}
    >
      <span className="audio-chip-tri" aria-hidden="true" />
      <span className="audio-chip-lang">{label}</span>
      {state === 'error' && <span className="audio-chip-bad">missing</span>}
    </button>
  );
};

export default AudioChip;
