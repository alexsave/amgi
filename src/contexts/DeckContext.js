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
   * `language`/`learningFieldIndex` are optional and only feed the
   * romanisation guard on the server (see route.js and cardText.ts's
   * looksRomanized) - omitting either just means nothing is checked.
   * Refreshes the deck's note count and the first page of its card list.
   */
  const addAnkiNote = useCallback(async (deckId, { notetypeId, fields, tags = [], language, learningFieldIndex }) => {
    const result = await ankiApi.addNote({
      deckId: Number(deckId),
      notetypeId,
      fields,
      tags,
      language,
      learningFieldIndex,
    });
    await Promise.all([
      loadDeckCards(deckId, { offset: 0, limit: deckCards[deckId]?.limit || 20 }),
      refreshAnkiDecks(),
    ]);
    return result;
  }, [loadDeckCards, refreshAnkiDecks, deckCards]);

  /**
   * Add several notes to an Anki deck in one call - the bulk-add-from-paste
   * screen's write path (see BulkRun.js). `notes` is already shaped as
   * the transport wants it (one {notetypeId, fields, tags, language,
   * learningFieldIndex} per line); this only adds `deckId` and refreshes the
   * deck once at the end, the same "refresh after the write, not during it"
   * shape addAnkiNote uses - refreshing per note would mean 60 re-fetches
   * for one paste.
   *
   * `refresh: false` is for the caller that writes several batches in a row
   * and owns the refresh itself: BulkRun cuts a batch every few seconds so
   * that closing the tab cannot cost a finished card, and refreshing after
   * each of those would reintroduce, one refresh per batch, the very
   * amplification batching exists to remove. That caller refreshes exactly
   * once, when its last batch has landed.
   */
  const addAnkiNotesBulk = useCallback(async (deckId, notes, { refresh = true } = {}) => {
    const { results } = await ankiApi.addNotesBulk(notes.map((note) => ({ ...note, deckId: Number(deckId) })));
    if (refresh) {
      await Promise.all([
        loadDeckCards(deckId, { offset: 0, limit: deckCards[deckId]?.limit || 20 }),
        refreshAnkiDecks(),
      ]);
    }
    return results;
  }, [loadDeckCards, refreshAnkiDecks, deckCards]);

  /**
   * Replace one note's field contents in place, without touching tags or
   * regenerating its cards - what the bulk-add screen's audio-generation
   * follow-up pass uses to write a clip into a note after the note itself
   * was already added (see ankiApi.updateNote). Deliberately does not
   * refresh the deck's card list itself: a follow-up pass calls this once
   * per line, and refreshing after every single one would be the same
   * "spam the UI 60 times" problem the bulk-add endpoint exists to avoid on
   * the write side - the caller refreshes once when the whole pass finishes.
   */
  const updateAnkiNote = useCallback(async (noteId, fields, options) => {
    return ankiApi.updateNote(noteId, fields, options);
  }, []);

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
  // Reacting to Anki opening and closing, without a page reload.
  //
  // The status itself was already polled here, which is why the badge always
  // kept up. What did not keep up was everything the status implies: closing
  // Anki flips the transport from "locked" to "direct", and the deck list was
  // still whatever it had been when the page loaded - usually empty, with the
  // locked explanation under it - until somebody reloaded the tab by hand.
  // The fix is to treat a CHANGE of mode as the event, not the poll: when the
  // mode moves, re-fetch the decks, and the notes of whichever deck is open.
  //
  // Refs rather than effect dependencies for the deck bits, deliberately:
  // putting currentDeckId or loadDeckCards in the dependency array would tear
  // down and restart the interval every time you opened a deck, which is the
  // opposite of what a heartbeat should do.
  const deckStateRef = useRef({ currentDeckId: null, loadDeckCards: null, refreshAnkiDecks: null });
  deckStateRef.current = { currentDeckId, loadDeckCards, refreshAnkiDecks };

  useEffect(() => {
    let cancelled = false;
    let lastMode = null;

    const reactToModeChange = () => {
      const { currentDeckId: deckId, loadDeckCards: loadCards, refreshAnkiDecks: refreshDecks } = deckStateRef.current;
      if (refreshDecks) refreshDecks();
      // A deck open on screen has its own list of notes, which is just as
      // stale as the deck list was.
      if (deckId && loadCards) loadCards(deckId);
    };

    const pollStatus = async () => {
      try {
        const status = await ankiApi.status();
        if (cancelled) return;
        setAnkiStatus(status);
        if (status.mode !== lastMode) {
          const first = lastMode === null;
          lastMode = status.mode;
          // The first poll is the page loading, which already fetches below.
          if (!first) reactToModeChange();
        }
      } catch {
        // The /api/anki/status route itself always answers 200 with a mode;
        // reaching this catch means the fetch call failed outright (dev
        // server not up yet), which is not a mode worth reporting.
      }
    };

    pollStatus();
    refreshAnkiDecks();
    const interval = setInterval(pollStatus, 4000);

    // Coming back to the tab is the single most likely moment for the answer
    // to have changed, because the usual way it changes is that you were just
    // in Anki. Poll straight away rather than waiting out the interval.
    const onVisible = () => { if (!document.hidden) pollStatus(); };
    const onSettingsChanged = () => {
      pollStatus();
      refreshAnkiDecks();
    };
    window.addEventListener(ANKI_SETTINGS_CHANGED_EVENT, onSettingsChanged);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener(ANKI_SETTINGS_CHANGED_EVENT, onSettingsChanged);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
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
    addAnkiNotesBulk,
    updateAnkiNote,
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
