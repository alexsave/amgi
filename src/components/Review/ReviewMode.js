'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MicrophoneIcon, PlayIcon, SpeakerWaveIcon } from '@heroicons/react/24/solid';
import { useDecks } from '../../contexts/DeckContext';
import { useAudio } from '../../contexts/useAudio';
import { useReview } from '../../contexts/ReviewContext';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import { detectSpeechEnd } from '../../utils/voiceActivity';
import RadialAudioVisualizer from './RadialAudioVisualizer';
import './ReviewMode.css';

// One card runs through these phases, hands-free:
//   prompt    - the card's audio plays; this is the question
//   listening - the mic is open; voice activity decides when you're done
//   answer    - the native audio plays back and you grade yourself
const PHASE = { IDLE: 'idle', PROMPT: 'prompt', LISTENING: 'listening', ANSWER: 'answer' };

// AI pronunciation checking is still here, but it is no longer a button in the
// header: it's opt-in per device (localStorage.amgi_ai_check = 'true'). Even
// with it on you grade yourself - the AI verdict is advice, not the score.
const AI_CHECK_KEY = 'amgi_ai_check';

const ReviewMode = () => {
  const { decks, currentDeckId } = useDecks();
  const router = useRouter();
  const audio = useAudio();
  const review = useReview();
  const { currentCard, currentCardId, newCardsCount, reviewCardsCount, learningCardsCount } = review;

  const [phase, setPhase] = useState(PHASE.IDLE);
  const [started, setStarted] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [statusNote, setStatusNote] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);

  // Bumped whenever the flow is cancelled (card graded, unmounted, restarted)
  // so in-flight async steps from the previous card bail out instead of
  // fighting the new one.
  const runIdRef = useRef(0);
  const stopVadRef = useRef(null);
  const userRecordingUrlRef = useRef(null);
  const userAudioElRef = useRef(null);
  const aiCheckRef = useRef(false);

  useEffect(() => {
    try {
      aiCheckRef.current = window.localStorage.getItem(AI_CHECK_KEY) === 'true';
    } catch {
      aiCheckRef.current = false;
    }
  }, []);

  const deck = decks[currentDeckId];

  const cancelRun = useCallback(() => {
    runIdRef.current += 1;
    if (stopVadRef.current) {
      stopVadRef.current();
      stopVadRef.current = null;
    }
    return runIdRef.current;
  }, []);

  const storeUserRecording = (blob) => {
    if (userRecordingUrlRef.current) {
      URL.revokeObjectURL(userRecordingUrlRef.current);
    }
    userRecordingUrlRef.current = URL.createObjectURL(new Blob([blob], { type: 'audio/mp3' }));
    setHasRecording(true);
  };

  const playUserRecording = () => {
    if (!userRecordingUrlRef.current) return;
    if (!userAudioElRef.current) {
      userAudioElRef.current = new Audio();
    }
    userAudioElRef.current.src = userRecordingUrlRef.current;
    userAudioElRef.current.play().catch(() => {});
  };

  const { evaluateSpeech } = useSpeechEvaluation({
    audio,
    onEvaluationResult: (data) => setAiResult(data),
  });

  // --- the per-card loop -------------------------------------------------

  const revealAnswer = useCallback(
    async (runId, recording) => {
      if (runId !== runIdRef.current) return;
      setPhase(PHASE.ANSWER);

      const card = currentCard;
      if (card?.back_audio_path) {
        await audio.playAudioToEnd(card.back_audio_path).catch(() => {});
      }
      if (runId !== runIdRef.current) return;

      if (aiCheckRef.current && recording && card?.back_audio_path) {
        setIsEvaluating(true);
        try {
          await evaluateSpeech(recording, card);
        } catch {
          // The AI verdict is optional; self-grading carries the session.
          setAiResult(null);
        } finally {
          if (runId === runIdRef.current) setIsEvaluating(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [audio, currentCard]
  );

  const finishListening = useCallback(
    async (runId, reason) => {
      if (runId !== runIdRef.current) return;
      if (stopVadRef.current) {
        stopVadRef.current();
        stopVadRef.current = null;
      }

      let recording = null;
      try {
        recording = await audio.stopRecording();
      } catch {
        recording = null;
      }

      if (runId !== runIdRef.current) return;

      if (recording && reason !== 'no-speech') {
        storeUserRecording(recording);
      }
      if (reason === 'no-speech') {
        setStatusNote("Didn't hear an answer - here's the native audio.");
      }

      await revealAnswer(runId, recording);
    },
    [audio, revealAnswer]
  );

  const runCard = useCallback(
    async (card) => {
      const runId = cancelRun();

      setAiResult(null);
      setStatusNote(null);
      setHasRecording(false);
      setPhase(PHASE.PROMPT);

      if (card?.front_audio_path) {
        await audio.playAudioToEnd(card.front_audio_path).catch(() => {});
      }
      if (runId !== runIdRef.current) return;

      if (micDenied) {
        await revealAnswer(runId, null);
        return;
      }

      try {
        await audio.startRecording();
      } catch (err) {
        if (runId !== runIdRef.current) return;
        setMicDenied(true);
        setStatusNote(`Microphone unavailable: ${err.message}`);
        await revealAnswer(runId, null);
        return;
      }

      if (runId !== runIdRef.current) {
        await audio.stopRecording().catch(() => {});
        return;
      }

      setPhase(PHASE.LISTENING);
      stopVadRef.current = detectSpeechEnd({
        audioContext: audio.audioContextRef.current,
        stream: audio.recordingStreamRef.current,
        onEnd: (reason) => finishListening(runId, reason),
      });
    },
    [audio, cancelRun, finishListening, micDenied, revealAnswer]
  );

  // Each new card restarts the loop. Nothing happens until the reviewer has
  // started the session, which is also the gesture that unlocks audio
  // playback and prompts for the microphone.
  useEffect(() => {
    if (!started || !currentCard) return;
    runCard(currentCard);
    // Keyed on the card id so each card runs exactly once, no matter how
    // often runCard's dependencies change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, currentCardId]);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      if (stopVadRef.current) stopVadRef.current();
      if (userRecordingUrlRef.current) URL.revokeObjectURL(userRecordingUrlRef.current);
    };
  }, []);

  // --- actions -----------------------------------------------------------

  const handleStart = useCallback(async () => {
    try {
      // Asking here (inside the click) is both the consent prompt and the
      // gesture browsers require before audio may play on its own.
      await audio.ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicDenied(false);
    } catch {
      setMicDenied(true);
      setStatusNote(
        'Microphone access was declined - cards still play, and you can grade yourself.'
      );
    }
    setStarted(true);
  }, [audio]);

  const grade = useCallback(
    (correct) => {
      cancelRun();
      if (audio.isRecording) {
        audio.stopRecording().catch(() => {});
      }
      setPhase(PHASE.IDLE);
      setAiResult(null);
      setStatusNote(null);
      if (correct) {
        review.markCorrectGetNext();
      } else {
        review.markAgainGetNext();
      }
    },
    [audio, cancelRun, review]
  );

  const stopListeningEarly = useCallback(() => {
    finishListening(runIdRef.current, 'manual');
  }, [finishListening]);

  const handleBackToList = () => {
    cancelRun();
    if (audio.isRecording) {
      audio.stopRecording().catch(() => {});
    }
    review.syncCardsToDeck();
    router.push('/decks');
  };

  // Anki's keys: space (or enter) is "Good", 1 is "Again". While the mic is
  // open, space means "I'm done talking".
  useEffect(() => {
    const onKeyDown = (event) => {
      const target = event.target;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }

      if (!started) {
        if (event.code === 'Space' || event.code === 'Enter') {
          event.preventDefault();
          handleStart();
        }
        return;
      }

      if (phase === PHASE.LISTENING && event.code === 'Space') {
        event.preventDefault();
        stopListeningEarly();
        return;
      }

      if (phase !== PHASE.ANSWER) return;

      if (event.code === 'Space' || event.code === 'Enter' || event.key === '3') {
        event.preventDefault();
        grade(true);
      } else if (event.key === '1') {
        event.preventDefault();
        grade(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, started, grade, stopListeningEarly, handleStart]);

  // --- render ------------------------------------------------------------

  if (!deck) {
    return null;
  }

  if (!currentCard) {
    return (
      <div className="review-mode">
        <div className="review-complete">
          <h3>🎉 Review Complete!</h3>
          <p>You&apos;ve reviewed all due cards in this deck.</p>
          <button onClick={handleBackToList} className="back-btn">
            Back to Decks
          </button>
        </div>
      </div>
    );
  }

  const revealed = phase === PHASE.ANSWER;

  const statusText = () => {
    if (!started) return 'Ready when you are';
    if (phase === PHASE.PROMPT) return 'Listen…';
    if (phase === PHASE.LISTENING) return 'Speak your answer';
    if (phase === PHASE.ANSWER) {
      return isEvaluating ? 'Checking your pronunciation…' : 'How did you do?';
    }
    return '';
  };

  return (
    <div className="review-mode">
      <div className="mode-header">
        <button onClick={handleBackToList} className="back-btn">
          ← Decks
        </button>
        <h2>{deck.name}</h2>
        <div className="review-counts">
          <span className="count-new">{newCardsCount} new</span>
          <span className="count-learning">{learningCardsCount} learning</span>
          <span className="count-review">{reviewCardsCount} review</span>
        </div>
      </div>

      <div className="review-stage">
        <div className="review-status">
          <span className={`review-phase review-phase-${phase}`}>{statusText()}</span>
          {statusNote && <span className="review-note">{statusNote}</span>}
        </div>

        <div className="flashcard-container">
          <div className="flashcard-top">
            <div className={`flashcard-text front ${revealed ? '' : 'is-hidden'}`}>
              {currentCard.front_text}
            </div>
          </div>
          <div className="flashcard-bottom">
            <div className={`flashcard-text back ${revealed ? '' : 'is-hidden'}`}>
              {currentCard.back_text}
            </div>
          </div>
        </div>

        {aiResult && (
          <div className={`evaluation-result ${aiResult.result}`}>
            <p>{aiResult.message}</p>
            {aiResult.transcription && (
              <p className="evaluation-transcription">Heard: “{aiResult.transcription}”</p>
            )}
          </div>
        )}
      </div>

      {!started ? (
        <div className="review-gate">
          <p className="review-gate-text">
            You&apos;ll hear the phrase, then amgi listens for your answer and plays the native
            audio back. Starting gives this page your microphone.
          </p>
          <button className="primary-btn" onClick={handleStart}>
            Start reviewing
          </button>
          <p className="review-gate-hint">Space to start</p>
        </div>
      ) : (
        <div className="review-footer">
          <div className="review-visualizer">
            <RadialAudioVisualizer
              visualizerType="user"
              isActive={audio.isRecording}
              key={`user-visualizer-${audio.isRecording}`}
            />
            <div className={`review-mic ${phase === PHASE.LISTENING ? 'is-listening' : ''}`}>
              {phase === PHASE.LISTENING ? (
                <MicrophoneIcon className="review-mic-icon" />
              ) : (
                <SpeakerWaveIcon className="review-mic-icon" />
              )}
            </div>
          </div>

          {phase === PHASE.ANSWER ? (
            <>
              <div className="replay-row">
                <button
                  className="replay-btn"
                  onClick={() => audio.playAudio(currentCard.front_audio_path).catch(() => {})}
                  disabled={!currentCard.front_audio_path}
                >
                  <PlayIcon className="icon" /> Prompt
                </button>
                <button
                  className="replay-btn"
                  onClick={() => audio.playAudio(currentCard.back_audio_path).catch(() => {})}
                  disabled={!currentCard.back_audio_path}
                >
                  <PlayIcon className="icon" /> Native
                </button>
                <button className="replay-btn" onClick={playUserRecording} disabled={!hasRecording}>
                  <PlayIcon className="icon" /> You
                </button>
              </div>
              <div className="grade-row">
                <button className="grade-btn again" onClick={() => grade(false)}>
                  Again <kbd>1</kbd>
                </button>
                <button className="grade-btn good" onClick={() => grade(true)}>
                  Good <kbd>space</kbd>
                </button>
              </div>
            </>
          ) : (
            <div className="grade-row">
              <button
                className="grade-btn ghost"
                onClick={stopListeningEarly}
                disabled={phase !== PHASE.LISTENING}
              >
                Done speaking <kbd>space</kbd>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ReviewMode;
