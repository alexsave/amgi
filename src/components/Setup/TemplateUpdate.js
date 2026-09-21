import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { loadAnkiSettings } from '../../utils/ankiSettings';
import './TemplateUpdate.css';

// Getting a newer card design onto a machine that was set up months ago.
//
// There are two halves and they fail independently. The website copies
// amgi's files into the add-on folder; the add-on, which is the only thing
// that can write a note type, copies them into the collection at the next
// profile open. For a long time neither half was checked, so a design change
// only ever reached people who had never installed amgi.
//
// Checking the first half was the obvious fix and it was not enough, in a
// way worth recording because the failure looked exactly like success. The
// files were current on disk, every screen said so, and the card on screen
// in Anki was still last week's - because Anki had last opened the profile
// fifteen minutes BEFORE the copy landed, and nothing anywhere was asking
// the collection what it actually held. "Did we do our part" is not the
// question anyone has.
//
// So both halves are checked now (installState's own state, plus
// collectionDrift comparing the collection's templates and media against
// what this build ships), and the two produce different sentences:
//
//   files behind      -> amgi fixes it itself, then says to restart Anki
//   collection behind -> only Anki can fix it, so it says so, and keeps
//                        saying it until Anki has actually caught up
//
// The second is why there is no longer any "sticky" bookkeeping here. An
// earlier version had to remember that it had just copied files, because a
// re-check would find them current and erase a notice that was still true.
// Now the notice is driven by a condition that is still true, so a re-check
// re-derives it and StrictMode's double pass is simply harmless.

const RESTART = 'restart Anki';

// Which modes mean "Anki is open right now". Writing into the add-ons folder
// while it is means writing underneath a running program that has already
// imported those files.
const ANKI_IS_OPEN = new Set(['bridge', 'bridge-no-collection', 'locked']);

const TemplateUpdate = () => {
  const { ankiStatus } = useDecks();
  // Read out here rather than inside check(): the compiler tracks the whole
  // ankiStatus object as the dependency otherwise, and re-makes the callback
  // on every poll that returns an equal-but-new object.
  const ankiMode = ankiStatus?.mode;
  const [state, setState] = useState({ phase: 'checking', message: '' });
  // Only to stop two passes copying the same files over each other at once -
  // not fatal, but a real filesystem race for no reason.
  const running = useRef(false);

  const check = useCallback(async (force = false) => {
    if (running.current) return;
    running.current = true;
    try {
      let status = await ankiApi.installState();
      if (!status.installed) {
        setState({ phase: 'idle', message: '' });
        return;
      }

      // `upToDate` is null when this build cannot tell - a packaged copy
      // with no add-on sources in it. Unknown is not stale.
      if (status.upToDate === false) {
        // Never while Anki is open, unless the person says so.
        //
        // This used to copy the moment it noticed, on page load, whatever
        // Anki happened to be doing - and it was seen doing it in the middle
        // of a review. Nothing here touches the collection, so no cards were
        // ever at risk, but rewriting the add-ons folder under a running
        // Anki is still writing under a program that imported those files at
        // startup and is still running the bridge server out of them. The
        // right moment is one the person picks, and the honest default while
        // they are mid-session is to say so and wait.
        if (ANKI_IS_OPEN.has(ankiMode) && !force) {
          setState({ phase: 'offered', message: '' });
          return;
        }
        setState({ phase: 'updating', message: '' });
        await ankiApi.install(loadAnkiSettings().baseDirOverride);
        status = await ankiApi.installState();
      }

      const behind = status.collectionChecked && status.collectionStale.length > 0;
      setState({ phase: behind ? 'behind' : 'idle', message: '' });
    } catch (error) {
      setState({ phase: 'failed', message: error.message });
    } finally {
      running.current = false;
    }
  }, [ankiMode]);

  // Wrapped in an async function rather than called straight from the effect
  // body: every setState lands after an await, which keeps this a
  // subscription to an external system rather than a cascading render.
  useEffect(() => {
    let live = true;
    (async () => {
      if (live) await check();
    })();
    return () => { live = false; };
  }, [check]);

  if (state.phase === 'checking' || state.phase === 'idle') return null;

  return (
    <div className={`template-update is-${state.phase}`} role="status">
      {state.phase === 'updating' && <span>Updating amgi&rsquo;s files in Anki…</span>}
      {state.phase === 'offered' && (
        <>
          <span>
            amgi has a newer card design, and Anki is open. Installing it rewrites amgi&rsquo;s
            add-on while Anki is running, so it is waiting for you.
          </span>
          <button type="button" className="template-update-dismiss" onClick={() => check(true)}>
            Install now
          </button>
        </>
      )}
      {state.phase === 'behind' && (
        <>
          <span>
            amgi has a newer card design. Anki picks it up when it next opens your
            collection, so <strong>{RESTART}</strong> to see it.
          </span>
          <button type="button" className="template-update-dismiss" onClick={check}>
            I have restarted Anki
          </button>
        </>
      )}
      {state.phase === 'failed' && (
        <>
          <span>Could not update amgi&rsquo;s files in Anki: {state.message}</span>
          <button type="button" className="template-update-dismiss" onClick={check}>Try again</button>
        </>
      )}
    </div>
  );
};

export default TemplateUpdate;
