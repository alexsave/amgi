import React, { useCallback, useEffect, useState } from 'react';
import { ankiApi } from '../../utils/ankiApi';
import { loadAnkiSettings, saveAnkiSettings } from '../../utils/ankiSettings';
import { useDecks } from '../../contexts/DeckContext';
import './FirstRun.css';

// The whole app, until amgi is set up in Anki.
//
// This replaces what used to be here: one grey sentence saying "No Anki
// profile selected yet. Open Settings to pick one." That named a screen you
// then had to go and find, and once you found it you had to scan for
// profiles, choose one, save, and then separately go and install the add-ons
// by hand. Every one of those steps had exactly one sensible answer on a
// normal machine, so none of them is asked any more: the scan runs on mount,
// a machine with exactly one profile has it chosen, and the only thing left
// on screen is the button that does the install.
//
// More than one profile is the one case that genuinely needs a person, so it
// is the only case that asks.

const FirstRun = () => {
  const { refreshAnkiDecks } = useDecks();
  const [scan, setScan] = useState({ loading: true, baseDir: '', baseDirExists: null, profiles: [], error: '' });
  const [chosen, setChosen] = useState(() => loadAnkiSettings().collectionPath);
  const [install, setInstall] = useState({ running: false, done: false, message: '', ok: null });

  const choose = useCallback((profile) => {
    const next = { ...loadAnkiSettings(), collectionPath: profile.collectionPath, profileName: profile.name };
    saveAnkiSettings(next);
    setChosen(profile.collectionPath);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await ankiApi.profiles();
        if (!live) return;
        setScan({ loading: false, error: '', ...result });
        // Exactly one profile is the normal case and needs no decision.
        if (result.profiles.length === 1 && !loadAnkiSettings().collectionPath) choose(result.profiles[0]);
      } catch (error) {
        if (live) setScan((prev) => ({ ...prev, loading: false, error: error.message }));
      }
    })();
    return () => { live = false; };
  }, [choose]);

  const runInstall = async () => {
    setInstall({ running: true, done: false, message: '', ok: null });
    try {
      const result = await ankiApi.install(loadAnkiSettings().baseDirOverride);
      setInstall({ running: false, done: true, message: result.message, ok: true });
      refreshAnkiDecks();
    } catch (error) {
      setInstall({ running: false, done: false, message: error.message, ok: false });
    }
  };

  const profile = scan.profiles.find((p) => p.collectionPath === chosen);
  const needsChoice = scan.profiles.length > 1 && !profile;
  const noAnki = !scan.loading && scan.baseDirExists === false;

  return (
    <div className="first-run">
      <h2 className="first-run-title">Set amgi up in your Anki</h2>
      <p className="first-run-lead">One press: the add-ons, and the card type amgi builds decks with.</p>

      <button
        type="button"
        className="first-run-cta"
        onClick={runInstall}
        disabled={install.running || noAnki}
      >
        {install.running ? 'Installing…' : install.done ? 'Install again' : 'Install into Anki'}
      </button>

      {scan.baseDir && (
        <p className="first-run-path">
          <code>{scan.baseDir}</code>
          {profile ? <> · profile &ldquo;{profile.name}&rdquo;</> : null}
        </p>
      )}

      {noAnki && (
        <p className="first-run-error">
          No Anki data folder on this machine. Install Anki from apps.ankiweb.net and open it once, then reload.
        </p>
      )}
      {scan.error && <p className="first-run-error">{scan.error}</p>}
      {install.ok === false && <p className="first-run-error">{install.message}</p>}

      {needsChoice && (
        <div className="first-run-choices">
          <p className="first-run-step-text">More than one Anki profile here. Which one?</p>
          {scan.profiles.map((p) => (
            <button key={p.collectionPath} type="button" className="first-run-choice" onClick={() => choose(p)}>
              {p.name}
            </button>
          ))}
        </div>
      )}

      <ol className="first-run-steps">
        <Step state={scan.loading ? 'now' : profile ? 'done' : 'next'} mark={profile ? '✓' : '1'}>
          {scan.loading
            ? 'Looking for Anki…'
            : profile
              ? `Found Anki: profile “${profile.name}”${scan.profiles.length === 1 ? ', picked for you' : ''}`
              : 'Could not find an Anki profile'}
        </Step>
        <Step state={install.done ? 'done' : install.running ? 'now' : 'next'} mark={install.done ? '✓' : '2'}>
          {install.done
            ? 'Installed the add-ons and the card type'
            : install.running
              ? 'Installing the add-ons and the card type'
              : 'Install the add-ons and the card type'}
        </Step>
        <Step state={install.done ? 'now' : 'next'} mark="3">
          Restart Anki, and amgi notices by itself
        </Step>
      </ol>
    </div>
  );
};

const Step = ({ state, mark, children }) => (
  <li className={`first-run-step ${state}`}>
    <span className="first-run-mark">{mark}</span>
    <span className="first-run-step-text">{children}</span>
  </li>
);

export default FirstRun;
