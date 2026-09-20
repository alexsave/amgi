import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDecks } from '../../contexts/DeckContext';
import { ankiApi } from '../../utils/ankiApi';
import { LANGUAGES } from '../../constants/languages';
import { saveDeckLanguages } from '../../utils/deckLanguagePrefs';
import './StarterDeck.css';

// The offer of a free sample deck, on a machine that cannot make its own.
//
// Everything amgi builds costs an OpenAI call, so without a key the app is a
// working tool with nothing in it and no way to see what a finished card
// even looks like - which is the worst possible first impression, because
// the thing being judged is the card. Ten ready-made phrases with real
// recordings fix that for nothing.
//
// It appears only when there is no key. With one, a person can make cards
// about whatever they actually care about, and ten fixed phrases would be a
// worse first deck than any of those - so the offer would be clutter rather
// than help. The server decides this (starterDeck.js's starterState) and
// never sends the key or anything derived from it, only whether one exists.

const label = (code) => LANGUAGES[code]?.name || code;
const flag = (code) => LANGUAGES[code]?.flag || '🌍';

const StarterDeck = () => {
  const router = useRouter();
  const { refreshAnkiDecks } = useDecks();
  const [state, setState] = useState({ loading: true, offered: false, languages: [], phraseCount: 0 });
  const [known, setKnown] = useState('en');
  const [learning, setLearning] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const result = await ankiApi.starterState();
        if (!live) return;
        setState({ loading: false, ...result });
        // Pre-picked rather than left blank, so the common case is one press:
        // the first language that is not the one already chosen as known.
        const ordered = Object.keys(LANGUAGES).filter((code) => result.languages.includes(code));
        setLearning(ordered.find((code) => code !== 'en') || '');
      } catch {
        if (live) setState({ loading: false, offered: false, languages: [], phraseCount: 0 });
      }
    })();
    return () => { live = false; };
  }, []);

  const build = async () => {
    setBusy(true);
    setError('');
    try {
      const name = `amgi starter - ${label(learning)}`;
      const built = await ankiApi.buildStarter(known, learning, name);
      // The pair the deck was built from is what the deck screen needs to
      // know, and nothing in Anki records it - a deck is a name and a note
      // type - so it is written here rather than guessed at later.
      saveDeckLanguages(built.deckId, { known, learning });
      await refreshAnkiDecks();
      router.push(`/deck/${built.deckId}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (state.loading || !state.offered) return null;

  // Ordered the way every other language list in amgi is ordered - the
  // order LANGUAGES itself declares - rather than the alphabetical set the
  // server happens to answer with. Alphabetical put Arabic first, so the
  // pre-picked "I am learning" on a fresh install was العربية for everyone,
  // which reads as a choice amgi made about them rather than a default.
  const options = Object.keys(LANGUAGES).filter((code) => state.languages.includes(code));

  return (
    <div className="starter-deck">
      <h3 className="starter-deck-title">Try it without an OpenAI key</h3>
      <p className="starter-deck-lead">
        amgi writes and records cards with OpenAI, and there is no key set here, so it cannot
        make one yet. This deck is {state.phraseCount} everyday phrases that came with amgi,
        already recorded in both languages - a real deck you can review, edit and delete.
      </p>

      <div className="starter-deck-pair">
        <label className="starter-deck-field">
          <span>I know</span>
          <select value={known} onChange={(e) => setKnown(e.target.value)} disabled={busy}>
            {options.map((code) => (
              <option key={code} value={code}>{flag(code)} {label(code)}</option>
            ))}
          </select>
        </label>
        <label className="starter-deck-field">
          <span>I am learning</span>
          <select value={learning} onChange={(e) => setLearning(e.target.value)} disabled={busy}>
            {options.filter((code) => code !== known).map((code) => (
              <option key={code} value={code}>{flag(code)} {label(code)}</option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        className="starter-deck-cta"
        onClick={build}
        disabled={busy || !learning || learning === known}
      >
        {busy ? 'Building the deck…' : 'Make me a starter deck'}
      </button>

      {error && <p className="starter-deck-error">{error}</p>}
      <p className="starter-deck-note">
        To make your own cards, put <code>OPENAI_API_KEY=…</code> in <code>.env.local</code> and
        restart amgi.
      </p>
    </div>
  );
};

export default StarterDeck;
