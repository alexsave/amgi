// Deck context: the data layer every deck/card screen reads from.
//
// amgi is local-first now - there is no account, no cloud deck, and no
// spaced-repetition state of its own. Every deck here is a real Anki deck,
// reached through whichever transport is live (see src/server/anki/transport.js);
// this context's job is picking that transport's results up through
// src/utils/ankiApi.js and reshaping them into the deck/card shape
// DeckList, DeckItem and CardList already know how to render.
'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ankiApi } from '../utils/ankiApi';
import { guessFields, hasAudioReference, stripHtmlForPreview } from '../utils/ankiFields';
import { ANKI_SETTINGS_CHANGED_EVENT } from '../utils/ankiSettings';

const DeckContext = createContext({});

/** A real Anki deck, reshaped into what DeckList/DeckItem render. */
function mapAnkiDeck(remote) {
  return {
    id: String(remote.id),
    ankiDeckId: remote.id,
    name: remote.name,
    noteCount: remote.noteCount,
  };
}

/**
 * Which field is "the prompt" and which is "the audio" is a per-note-type
 * guess (see ankiFields.js) - a deck can mix note types, so this is computed
 * per note, not once per deck. `front_text`/`back_text` are display-only
 * here (HTML stripped for a browsing list); `fields` keeps the real values
 * for anything that needs to write them back untouched.
 */
function mapAnkiNoteToCard(note, notetype) {
  const { textIndex, audioIndex } = guessFields(notetype || { fieldNames: note.fields.map((_, i) => `Field ${i}`) });
  const promptRaw = textIndex != null ? note.fields[textIndex] : note.fields[0];
  const audioFieldText = audioIndex != null ? note.fields[audioIndex] : undefined;
  return {
    id: note.id,
    notetypeId: note.notetypeId,
    notetypeName: notetype?.name || `Note type ${note.notetypeId}`,
    fields: note.fields,
    fieldNames: notetype?.fieldNames || [],
    textFieldIndex: textIndex,
    audioFieldIndex: audioIndex,
    front_text: stripHtmlForPreview(promptRaw ?? ''),
    back_text: audioFieldText !== undefined ? stripHtmlForPreview(audioFieldText) : '',
    hasAudio: audioFieldText !== undefined && hasAudioReference(audioFieldText),
    tags: note.tags,
  };
}

export const DeckProvider = ({ children }) => {
  const [decks, setDecks] = useState({});
  const [loading, setLoading] = useState(true);
  const [currentDeckId, setCurrentDeckId] = useState(null);
  const [error, setError] = useState(null);
  // Browsing state, one page at a time, keyed by deck id:
  // { cards, loading, error, offset, limit, hasMore }.
  const [deckCards, setDeckCards] = useState({});

  // What mode the Anki transport is in right now: 'bridge' | 'direct' |
  // 'locked' | 'not-found' | 'unsupported-schema' | 'bridge-no-collection' |
  // 'unconfigured'. This is the app's central piece of visible state (see
  // AnkiModeBadge) - re-fetched on an interval so it reflects reality
  // without needing a page reload when Anki opens, closes, or the bridge
  // toggles.
  const [ankiStatus, setAnkiStatus] = useState({ mode: 'unconfigured' });
  const [ankiNotetypes, setAnkiNotetypes] = useState([]);
  const notetypesRef = useRef(null);

  const ensureAnkiNotetypes = useCallback(async () => {
    if (notetypesRef.current) return notetypesRef.current;
    const { notetypes } = await ankiApi.notetypes();
    const byId = new Map(notetypes.map((nt) => [nt.id, nt]));
    notetypesRef.current = byId;
    setAnkiNotetypes(notetypes);
    return byId;
  }, []);

  /** Refetch the deck list from whichever Anki transport is currently reachable. */
  const refreshAnkiDecks = useCallback(async () => {
    try {
      const { mode, decks: remoteDecks } = await ankiApi.decks();
      setAnkiStatus((prev) => (prev.mode === mode ? prev : { mode }));
      setDecks((prev) => {
        const next = {};
        for (const remote of remoteDecks) {
          next[String(remote.id)] = mapAnkiDeck(remote);
        }
        return next;
      });
      setError(null);
    } catch (err) {
      // Not reachable right now (no profile picked, locked, bridge down) -
      // reported through ankiStatus, not the generic `error` state: this is
      // a mode the UI explains, not a failure it apologizes for.
      setAnkiStatus({ mode: err.mode || 'unconfigured', error: err.message });
    } finally {
      setLoading(false);
    }
  }, []);

  /** One page of a deck's notes, reshaped into the card list's card shape. */
  const loadDeckCards = useCallback(async (deckId, { offset = 0, limit = 20 } = {}) => {
    if (!deckId) return;
    setDeckCards((prev) => ({
      ...prev,
      [deckId]: { cards: prev[deckId]?.cards || [], loading: true, error: null, offset, limit },
    }));
    try {
      const notetypesById = await ensureAnkiNotetypes();
      const page = await ankiApi.notesInDeck(deckId, { offset, limit });
      const cards = page.notes.map((note) => mapAnkiNoteToCard(note, notetypesById.get(note.notetypeId)));
      setDeckCards((prev) => ({
        ...prev,
        [deckId]: { cards, loading: false, error: null, offset: page.offset, limit: page.limit, hasMore: page.hasMore },
      }));
    } catch (err) {
      setDeckCards((prev) => ({
        ...prev,
        [deckId]: { ...(prev[deckId] || { cards: [] }), loading: false, error: err.message },
      }));
    }
  }, [ensureAnkiNotetypes]);

  /**
   * Add a note to an Anki deck (fields already in the note type's field
   * order - the caller, CardForm, owns the field mapping the user picked).
   * Refreshes the deck's note count and the first page of its card list.
   */
  const addAnkiNote = useCallback(async (deckId, { notetypeId, fields, tags = [] }) => {
    const result = await ankiApi.addNote({ deckId: Number(deckId), notetypeId, fields, tags });
    await Promise.all([
      loadDeckCards(deckId, { offset: 0, limit: deckCards[deckId]?.limit || 20 }),
      refreshAnkiDecks(),
    ]);
    return result;
  }, [loadDeckCards, refreshAnkiDecks, deckCards]);

  /**
   * Create a deck directly in the Anki collection - "::" nesting is handled
   * server-side the same way Anki's own "Create Deck" would (see
   * plusaudio/lib/collection/decks.js).
   */
  const createNewDeck = useCallback(async ({ name }) => {
    const { deck: created } = await ankiApi.createDeck(name);
    await refreshAnkiDecks();
    return String(created.id);
  }, [refreshAnkiDecks]);

  // Status is polled independently of the deck list itself: a person leaving
  // Anki open on the setup screen, or toggling the bridge, should see the
  // banner change within a few seconds with no action of their own -
  // "re-probe when the situation changes rather than forcing a page reload"
  // is the whole reason this is an interval instead of a one-shot effect.
  useEffect(() => {
    let cancelled = false;
    const pollStatus = async () => {
      try {
        const status = await ankiApi.status();
        if (!cancelled) setAnkiStatus(status);
      } catch {
        // The /api/anki/status route itself always answers 200 with a mode;
        // reaching this catch means the fetch call failed outright (dev
        // server not up yet), which is not a mode worth reporting.
      }
    };
    pollStatus();
    refreshAnkiDecks();
    const interval = setInterval(pollStatus, 4000);
    const onSettingsChanged = () => {
      pollStatus();
      refreshAnkiDecks();
    };
    window.addEventListener(ANKI_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener(ANKI_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    };
  }, [refreshAnkiDecks]);

  const value = {
    decks,
    deckCards,
    loadDeckCards,
    loading,
    currentDeckId,
    setCurrentDeckId,
    error,
    setError,
    createNewDeck,
    addAnkiNote,
    ankiStatus,
    ankiNotetypes,
    ensureAnkiNotetypes,
    refreshAnkiDecks,
  };

  return (
    <DeckContext.Provider value={value}>
      {children}
    </DeckContext.Provider>
  );
};

export const useDecks = () => {
  const context = useContext(DeckContext);
  if (!context) {
    throw new Error('useDecks must be used within a DeckProvider');
  }
  return context;
};
