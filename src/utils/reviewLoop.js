// The review loop's sequencing, with no dependency on the app it runs in.
//
// amgi's web reviewer and the Anki card template drive the same three beats:
// the prompt audio plays, the microphone opens by itself and closes when the
// learner stops speaking, then the answer is revealed with the native audio.
// Only the effects differ between the two - one calls React state setters and
// Supabase-backed audio, the other calls `pycmd` and HTML5 <audio> elements -
// so the order, the cancellation rules and the fallbacks live here and each
// host passes in the effects.
//
// Constraints that keep this file portable: no imports other than the voice
// detector, no browser globals, and no host callback is ever allowed to throw
// into the machine. A card template that throws mid-review leaves the learner
// staring at a dead card, so every call out is wrapped.

import { detectSpeechEnd } from './voiceActivity';

export const PHASE = {
  IDLE: 'idle',
  // The prompt audio is playing.
  PROMPT: 'prompt',
  // openMic() has been called and hasn't settled yet. Worth a phase of its
  // own, not folded into PROMPT: a real permission prompt on a stock desktop
  // client can sit here for seconds (see micTimeoutMs), and a host that
  // leaves the previous phase's status on screen through that wait makes a
  // slow-but-normal permission dialog look like a hung card.
  REQUESTING_MIC: 'requesting-mic',
  // The microphone is open and voice activity decides when the turn ends.
  LISTENING: 'listening',
  // No microphone: the learner ends the turn themselves. The host decides how
  // long to sit here - amgi ends it immediately, the Anki template waits for a
  // key or a tap.
  WAITING: 'waiting',
  // Revealed: native audio and self-grading.
  ANSWER: 'answer',
};

const noop = () => {};

const safe = (fn) => {
  try {
    return fn();
  } catch {
    // A host callback failing must not strand the loop mid-card.
    return undefined;
  }
};

const safeAsync = async (fn) => {
  try {
    return await fn();
  } catch {
    return undefined;
  }
};

// A permission prompt is not guaranteed to ever settle. Real Anki desktop
// (Qt 6.11/WebEngine, no permission-handling add-on installed) leaves an
// unanswered getUserMedia() request in "ask" state forever: it neither
// resolves nor rejects. openMic() is host code this file does not control,
// so it is raced against a timer instead of trusted to always settle - the
// same shape the host already applies to clip playback (CLIP_START_TIMEOUT_MS
// in anki-loop.js), just for the one host promise that has no such guard.
const DEFAULT_MIC_TIMEOUT_MS = 15000;

const withTimeout = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`microphone request timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

/**
 * @param {object} host
 * @param {() => Promise<void>} [host.playPrompt]   resolves when the prompt audio has finished
 * @param {() => Promise<{audioContext: any, stream: any}>} [host.openMic]
 *        resolves with a live stream, or rejects if the microphone is unavailable.
 *        May also simply never settle (a real risk - see micTimeoutMs), so it is
 *        always raced against a timeout rather than awaited bare.
 * @param {() => Promise<any>} [host.closeMic]      resolves with a recording, or null
 * @param {number} [host.micTimeoutMs] how long to wait for openMic() before treating
 *        it as unavailable, same as a rejection. Defaults to 15s: long enough for a
 *        first-time permission prompt a learner has to notice and click.
 * @param {(result) => void|Promise<void>} [host.reveal]        show the answer
 * @param {() => Promise<void>} [host.playNative]   resolves when the native audio has finished
 * @param {(phase, info) => void} [host.onPhase]
 * @param {(error) => void} [host.onMicUnavailable]
 * @param {(result) => void|Promise<void>} [host.onAnswerReady] after the native audio
 * @param {function} [host.detect]                  swapped out in tests
 * @param {object} [host.vadOptions]                passed through to the detector
 */
export function createReviewLoop(host = {}) {
  const {
    playPrompt = noop,
    openMic = null,
    closeMic = noop,
    reveal = noop,
    playNative = noop,
    onPhase = noop,
    onMicUnavailable = noop,
    onAnswerReady = noop,
    detect = detectSpeechEnd,
    vadOptions,
    micTimeoutMs = DEFAULT_MIC_TIMEOUT_MS,
  } = host;

  // Bumped whenever a run is cancelled, so async steps from the previous card
  // bail out instead of fighting the new one.
  let runId = 0;
  let phase = PHASE.IDLE;
  let stopVad = null;
  let endCurrentTurn = null;
  // Once the microphone has been refused there is no point asking again on
  // every card: the prompt would fire per card and the answer will not change.
  let micUnavailable = false;

  const stale = (id) => id !== runId;

  const setPhase = (next, info) => {
    phase = next;
    safe(() => onPhase(next, info));
  };

  const releaseVad = () => {
    if (!stopVad) return;
    const stop = stopVad;
    stopVad = null;
    safe(stop);
  };

  /**
   * Abandons the current card. Safe to call at any time, including twice.
   * The phase is not announced: a cancel is always followed by the host doing
   * something else, and a flash of "idle" in between only causes flicker.
   */
  function cancel() {
    runId += 1;
    releaseVad();
    // A turn left unresolved would keep start()'s promise pending forever, so
    // the cancelled run is woken up and sees a stale id.
    const resolve = endCurrentTurn;
    endCurrentTurn = null;
    phase = PHASE.IDLE;
    if (resolve) resolve('cancelled');
    return runId;
  }

  /**
   * Ends the listening (or waiting) turn now, as "space" does.
   * @returns {boolean} whether there was a turn to end.
   */
  function endTurn(reason = 'manual') {
    if (!endCurrentTurn) return false;
    const resolve = endCurrentTurn;
    endCurrentTurn = null;
    releaseVad();
    resolve(reason);
    return true;
  }

  // The resolver is installed before the phase is announced, so a host that
  // ends the turn synchronously from onPhase (amgi does, when it has no
  // microphone) is not racing us.
  const awaitTurn = (id, enter) =>
    new Promise((resolve) => {
      endCurrentTurn = resolve;
      enter(id);
    });

  const listen = (id, mic) =>
    awaitTurn(id, () => {
      setPhase(PHASE.LISTENING);
      stopVad = detect({
        audioContext: mic && mic.audioContext,
        stream: mic && mic.stream,
        options: vadOptions,
        onEnd: (reason) => {
          if (stale(id)) return;
          endTurn(reason);
        },
      });
    });

  const waitForLearner = (id) => awaitTurn(id, () => setPhase(PHASE.WAITING, { reason: 'no-mic' }));

  async function answerBeat(id, result) {
    setPhase(PHASE.ANSWER, result);
    await safeAsync(() => reveal(result));
    if (stale(id)) return;
    await safeAsync(() => playNative(result));
    if (stale(id)) return;
    await safeAsync(() => onAnswerReady(result));
  }

  /** Runs one card from the top. Cancels any card already in flight. */
  async function start() {
    const id = cancel();
    setPhase(PHASE.PROMPT);
    await safeAsync(() => playPrompt());
    if (stale(id)) return;

    let mic = null;
    if (openMic && !micUnavailable) {
      setPhase(PHASE.REQUESTING_MIC);
      try {
        mic = await withTimeout(openMic(), micTimeoutMs);
      } catch (error) {
        micUnavailable = true;
        safe(() => onMicUnavailable(error));
      }
      if (stale(id)) {
        await safeAsync(() => closeMic());
        return;
      }
    }

    const reason = mic ? await listen(id, mic) : await waitForLearner(id);
    if (stale(id)) return;

    let recording = null;
    if (mic) recording = (await safeAsync(() => closeMic())) || null;
    if (stale(id)) return;

    // A turn that ended because nobody spoke has nothing worth replaying.
    await answerBeat(id, { reason, recording: reason === 'no-speech' ? null : recording });
  }

  /**
   * Picks the loop up at the answer, for hosts where revealing reloads the
   * page and the listening half has already happened. The Anki template's back
   * side is exactly this case.
   */
  async function resumeAtAnswer(result = {}) {
    const id = cancel();
    const info = { reason: 'revealed', recording: null, ...result };
    setPhase(PHASE.ANSWER, info);
    await safeAsync(() => playNative(info));
    if (stale(id)) return;
    await safeAsync(() => onAnswerReady(info));
  }

  return {
    start,
    endTurn,
    cancel,
    resumeAtAnswer,
    get phase() {
      return phase;
    },
    get micUnavailable() {
      return micUnavailable;
    },
    /** Lets a host that already knows the microphone is gone skip the prompt. */
    disableMic() {
      micUnavailable = true;
    },
  };
}
