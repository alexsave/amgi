'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MicrophoneIcon, PlayIcon, SpeakerWaveIcon } from '@heroicons/react/24/solid';
import { useDecks } from '../../contexts/DeckContext';
import { useAudio } from '../../contexts/useAudio';
import { useReview } from '../../contexts/ReviewContext';
import { useSpeechEvaluation } from '../../hooks/useSpeechEvaluation';
import { createReviewLoop, PHASE } from '../../utils/reviewLoop';
import RadialAudioVisualizer from './RadialAudioVisualizer';
import './ReviewMode.css';

// One card runs through these phases, hands-free:
//   prompt    - the card's audio plays; this is the question
//   listening - the mic is open; voice activity decides when you're done
//   answer    - the native audio plays back and you grade yourself
//
// The sequencing itself lives in utils/reviewLoop.js, which the Anki card
// template in anki/ ships too. This component supplies the effects.

// AI pronunciation checking is still here, but it is no longer a button in the
// header: it's opt-in per device (localStorage.amgi_ai_check = 'true'). Even
// with it on you grade yourself - the AI verdict is advice, not the score.
const AI_CHECK_KEY = 'amgi_ai_check';

const ReviewMode = () => {
  const { decks, currentDeckId } = useDecks();
  const router = useRouter();
  const audio = useAudio();
  const review = useReview();
  const {
    currentCard,
    currentCardId,
    newCardsCount,
    reviewCardsCount,
    learningCardsCount,
    saveState,
    retryFailedSaves
  } = review;

  const [phase, setPhase] = useState(PHASE.IDLE);
  const [started, setStarted] = useState(false);
  const [statusNote, setStatusNote] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);

  const userRecordingUrlRef = useRef(null);
  const userAudioElRef = useRef(null);
  const aiCheckRef = useRef(false);

  // The loop is created once and lives as long as the screen does, so its
  // effects read the current card and audio context through refs rather than
  // being rebuilt whenever React hands us new identities.
  const audioRef = useRef(audio);
  const cardRef = useRef(currentCard);
  const evaluateRef = useRef(null);
  const loopRef = useRef(null);

  useEffect(() => {
    try {
      aiCheckRef.current = window.localStorage.getItem(AI_CHECK_KEY) === 'true';
    } catch {
      aiCheckRef.current = false;
    }
  }, []);

  const deck = decks[currentDeckId];

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

  // Keep the loop's view of the world current without rebuilding it.
  useEffect(() => {
    audioRef.current = audio;
    cardRef.current = currentCard;
    evaluateRef.current = evaluateSpeech;
  });

  // --- the per-card loop -------------------------------------------------

  // Built in an effect rather than during render: the loop holds the mic and
  // the audio element, which are exactly the things a render must not touch.
  useEffect(() => {
    const loop = createReviewLoop({
      playPrompt: async () => {
        const card = cardRef.current;
        if (card?.front_audio_path) await audioRef.current.playAudioToEnd(card.front_audio_path);
      },
      openMic: async () => {
        await audioRef.current.startRecording();
        return {
          audioContext: audioRef.current.audioContextRef.current,
          stream: audioRef.current.recordingStreamRef.current,
        };
      },
      closeMic: () => audioRef.current.stopRecording(),
      onMicUnavailable: (error) => {
        setStatusNote(`Microphone unavailable: ${error?.message ?? 'no access'}`);
      },
      reveal: ({ reason, recording }) => {
        if (recording) storeUserRecording(recording);
        if (reason === 'no-speech') {
          setStatusNote("Didn't hear an answer - here's the native audio.");
        }
      },
      playNative: async () => {
        const card = cardRef.current;
        if (card?.back_audio_path) await audioRef.current.playAudioToEnd(card.back_audio_path);
      },
      onAnswerReady: async ({ recording }) => {
        const card = cardRef.current;
        if (!aiCheckRef.current || !recording || !card?.back_audio_path) return;
        setIsEvaluating(true);
        try {
          await evaluateRef.current(recording, card);
        } catch {
          // The AI verdict is optional; self-grading carries the session.
          setAiResult(null);
        } finally {
          setIsEvaluating(false);
        }
      },
      onPhase: (next) => {
        setPhase(next);
        // With no microphone amgi does not make the learner press anything:
        // the native audio and the grade buttons come straight away. The Anki
        // template answers this phase differently, which is why the loop asks
        // rather than deciding.
        if (next === PHASE.WAITING) loop.endTurn('no-mic');
      },
    });
    loopRef.current = loop;
    return () => {
      loop.cancel();
      loopRef.current = null;
      if (userRecordingUrlRef.current) URL.revokeObjectURL(userRecordingUrlRef.current);
    };
  }, []);

  const runCard = useCallback(() => {
    setAiResult(null);
    setStatusNote(null);
    setHasRecording(false);
    loopRef.current?.start();
  }, []);

  // Each new card restarts the loop. Nothing happens until the reviewer has
  // started the session, which is also the gesture that unlocks audio playback
  // and prompts for the microphone.
  useEffect(() => {
    if (!started || !currentCard) return;
    // The card run IS the effect: it drives audio playback and the microphone,
    // and the phase state it sets is how that external work is reported.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    runCard();
    // Keyed on the card id so each card runs exactly once, no matter how often
    // runCard's dependencies change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, currentCardId]);

  // --- actions -----------------------------------------------------------

  const handleStart = useCallback(async () => {
    try {
      // Asking here (inside the click) is both the consent prompt and the
      // gesture browsers require before audio may play on its own.
      await audio.ensureAudioContext();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      // The loop remembers this too, so it stops asking on every card.
      loopRef.current?.disableMic();
      setStatusNote(
        'Microphone access was declined - cards still play, and you can grade yourself.'
      );
    }
    setStarted(true);
  }, [audio]);

  const grade = useCallback(
    (correct) => {
      loopRef.current?.cancel();
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
    [audio, review]
  );

  const stopListeningEarly = useCallback(() => {
    loopRef.current?.endTurn('manual');
  }, []);

  const handleBackToList = () => {
    loopRef.current?.cancel();
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

  // A card with no prompt audio has nothing to play and nothing to show, since
  // the front is normally hidden until the answer - so it would be a silent
  // blank screen. Show the text and say why instead. Cards land in this state
  // legitimately: a starter deck is created before its audio is generated, and
  // generation can fail on quota.
  const silentPrompt = !currentCard.front_audio_path;
  const showFront = revealed || silentPrompt;

  // Deliberately persistent: an answer that did not reach the server stays
  // unsaved, and the whole point of the outbox is that it says so.
  const failedSaves = saveState?.failed ?? 0;
  const retryingSaves = (saveState?.pending ?? 0) > 0 && Boolean(saveState?.lastError);

  const statusText = () => {
    if (!started) return 'Ready when you are';
    if (phase === PHASE.PROMPT) return silentPrompt ? 'Read it out loud' : 'Listen…';
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

      {(failedSaves > 0 || retryingSaves) && (
        <div className="review-save-warning" role="status">
          <span>
            {failedSaves > 0
              ? `${failedSaves} answer${failedSaves === 1 ? '' : 's'} could not be saved.`
              : 'Trouble reaching the server - still retrying your answers.'}
          </span>
          {failedSaves > 0 && (
            <button type="button" className="review-save-retry" onClick={retryFailedSaves}>
              Retry
            </button>
          )}
        </div>
      )}

      <div className="review-stage">
        <div className="review-status">
          <span className={`review-phase review-phase-${phase}`}>{statusText()}</span>
          {statusNote && <span className="review-note">{statusNote}</span>}
          {started && silentPrompt && !statusNote && (
            <span className="review-note">This card has no audio yet - read it instead.</span>
          )}
        </div>

        <div className="flashcard-container">
          <div className="flashcard-top">
            <div className={`flashcard-text front ${showFront ? '' : 'is-hidden'}`}>
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
