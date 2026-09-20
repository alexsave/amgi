import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ankiApi } from '../../utils/ankiApi';
import { loadAnkiSettings } from '../../utils/ankiSettings';
import './TemplateUpdate.css';

// Getting a newer card design onto a machine that was set up months ago.
//
// Half of this already worked and the half that did not was invisible, which
// is the worst shape for a bug of this kind. The add-on compares the
// templates in its cardtype/ folder against the note type in the collection
// every time a profile opens, and rewrites the note type in place where they
// differ (anki/addon/amgi_bridge/notetype.py). So a card design change does
// propagate - as soon as the newer files reach that folder.
//
// Nothing ever put them there. "Install into Anki" is a button on the setup
// screen, and the setup screen only appears when amgi is NOT installed, so
// the one press that refreshes the files was unreachable to exactly the
// people who needed it. Someone who installed once kept reviewing the old
// card forever, with no screen anywhere saying a newer one existed.
//
// This closes that loop, and it does it without asking. Copying amgi's own
// files into amgi's own add-on folders is not a decision a person has
// information to make - there is no version of "no thanks, keep the stale
// template" that anybody wants - and the copy needs neither the collection
// closed nor Anki running. What does need saying is the part the website
// cannot do: the new design reaches the cards at the next profile open, so
// Anki has to be restarted. That is what the banner is for, and it is the
// only thing it says.

const TemplateUpdate = () => {
  const [state, setState] = useState({ phase: 'checking', message: '' });
  // Two refs, for two different ways a second check can lie about the first.
  //
  // `updated` makes the notice stick. A check that runs after the files have
  // been refreshed finds them current and would otherwise conclude there is
  // nothing to say - erasing the one sentence telling the person to restart
  // Anki, which is still true. React's StrictMode reproduces this every
  // time: effect, cleanup, effect on the same instance means the second pass
  // reads back the first pass's own work, and the banner vanished in
  // development while working in production. Keeping the wrong answer out of
  // reach beats making the second pass not happen.
  //
  // `running` stops two passes copying the same files over each other at
  // once, which is not fatal but is a real filesystem race for no reason.
  const updated = useRef(false);
  const running = useRef(false);

  const check = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const status = await ankiApi.installState();
      // `upToDate` is null when this build cannot tell - a packaged copy
      // with no add-on sources in it. Unknown must not be treated as stale,
      // or the banner appears on every load and the refresh never sticks.
      if (!status.installed || status.upToDate !== false) {
        setState({ phase: updated.current ? 'updated' : 'idle', message: '' });
        return;
      }
      setState({ phase: 'updating', message: '' });
      await ankiApi.install(loadAnkiSettings().baseDirOverride);
      updated.current = true;
      setState({ phase: 'updated', message: '' });
    } catch (error) {
      setState({ phase: 'failed', message: error.message });
    } finally {
      running.current = false;
    }
  }, []);

  // The check runs inside an async wrapper rather than being called straight
  // from the effect body: every setState in it lands after an await, which
  // is what keeps this a subscription to an external system (the add-ons
  // folder on disk) rather than a cascading render.
  useEffect(() => {
    let live = true;
    (async () => {
      if (live) await check();
    })();
    return () => { live = false; };
  }, [check]);

  const dismiss = () => {
    // Dismiss means dismiss, including across a later re-check: clearing the
    // sticky flag is what stops the notice coming back on the next render.
    updated.current = false;
    setState({ phase: 'idle', message: '' });
  };

  if (state.phase === 'checking' || state.phase === 'idle') return null;

  return (
    <div className={`template-update is-${state.phase}`} role="status">
      {state.phase === 'updating' && <span>Updating amgi&rsquo;s files in Anki…</span>}
      {state.phase === 'updated' && (
        <>
          <span>
            amgi has a newer card design. Its files are updated - <strong>restart Anki</strong> and
            your existing cards pick it up.
          </span>
          <button type="button" className="template-update-dismiss" onClick={dismiss}>
            Dismiss
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
