import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDecks } from '../../contexts/DeckContext';
import CardForm from './CardForm';
import AudioChip from './AudioChip';
import { loadDeckLanguages, saveDeckLanguages } from '../../utils/deckLanguagePrefs';
import { LANGUAGES } from '../../constants/languages';
import './CardList.css';

const PAGE_SIZE = 20;

// A note field holds the clip as <audio src="name.mp3">, which is the form
// the card template needs (Anki strips [sound:] tags before a template's
// JavaScript ever sees them). The filename is what the media route wants.
const AUDIO_SRC = /<audio[^>]*\ssrc\s*=\s*["']([^"']+)["']/i;

// back_text on a listed note is the AUDIO field with its HTML stripped (see
// DeckContext.mapAnkiNoteToCard), which renders as nothing at all for an
// <audio src> reference - which is why the second column came out empty.
// The text of a named field is what this list actually wants.
function textIn(card, fieldName) {
  const index = (card.fieldNames || []).findIndex((n) => n.toLowerCase() === fieldName.toLowerCase());
  if (index < 0) return '';
  return (card.fields?.[index] || '').replace(/<[^>]*>/g, '').trim();
}

function clipIn(card, fieldName) {
  const index = (card.fieldNames || []).findIndex((n) => n.toLowerCase() === fieldName.toLowerCase());
  if (index < 0) return '';
  const match = AUDIO_SRC.exec(card.fields?.[index] || '');
  return match ? match[1] : '';
}

const languageName = (code) => LANGUAGES[code]?.name || code;

const CardList = () => {
  const { id } = useParams();
  const router = useRouter();
  const { decks, deckCards, loadDeckCards, setCurrentDeckId } = useDecks();

  const deck = decks[id];

  useEffect(() => {
    loadDeckCards(id, { offset: 0, limit: PAGE_SIZE });
  }, [id, loadDeckCards]);

  const library = deckCards[id];
  const [langOverride, setLangOverride] = useState(null);
  const [langDeck, setLangDeck] = useState(id);
  const langs = langDeck === id && langOverride ? langOverride : loadDeckLanguages(id);
  const setLangs = (next) => { saveDeckLanguages(id, next); setLangDeck(id); setLangOverride(next); };
  const cards = library?.cards || [];

  const handleBack = () => {
    setCurrentDeckId(null);
    router.push('/decks');
  };

  // Pagination that survives a large deck: each page is fetched fresh
  // (offset/limit) rather than accumulated in memory, so a 333-note deck
  // costs one small page per click, not one big initial load.
  const goToPage = (direction) => {
    const offset = Math.max(0, (library?.offset || 0) + direction * (library?.limit || PAGE_SIZE));
    loadDeckCards(id, { offset, limit: library?.limit || PAGE_SIZE });
  };

  if (!deck) {
    return <div className="deck-cards"><p>Loading deck…</p></div>;
  }

  const listBody = () => {
    if (library?.error) {
      return (
        <div className="empty-deck">
          <p>Could not load this deck&apos;s notes: {library.error}</p>
        </div>
      );
    }
    if (cards.length === 0) {
      return (
        <div className="empty-deck">
          <p>{library && !library.loading ? 'No notes in this deck yet.' : 'Loading notes…'}</p>
        </div>
      );
    }
    return (
      <ol className="note-rows">
        {cards.map((cardData) => {
          const amgi = cardData.notetypeName === 'amgi Listening';
          return (
            <li key={cardData.id} className="note-row">
              <span className="note-row-target">{cardData.front_text}</span>
              <span className="note-row-cue">
                {amgi ? textIn(cardData, 'Cue') : (
                  <>
                    <span className="note-row-type">{cardData.notetypeName}</span> not an amgi card
                  </>
                )}
              </span>
              <span className="note-row-clips">
                <AudioChip filename={clipIn(cardData, 'CueAudio')} label={languageName(langs.known)} tone="cue" />
                <AudioChip filename={clipIn(cardData, 'TargetAudio')} label={languageName(langs.learning)} tone="target" />
                {amgi && !cardData.hasAudio && <small className="note-row-noaudio">no audio yet</small>}
              </span>
            </li>
          );
        })}
      </ol>
    );
  };

  return (
    <div className="deck-cards">
      <div className="deck-cards-header">
        <div className="deck-cards-title">
          <h1>{deck.name}</h1>
          <p className="deck-cards-sub">
            {deck.noteCount} card{deck.noteCount === 1 ? '' : 's'}
            {' · '}
            <DeckLanguages value={langs} onChange={setLangs} />
          </p>
        </div>
        <button onClick={handleBack} className="back-btn">← Decks</button>
      </div>

      <div className="deck-content">
        <CardForm deckId={id} languages={langs} onLanguagesChange={setLangs} />

        <div className="deck-cards-list">
          <div className="deck-cards-listhead">
            <h3>Cards in this deck</h3>
            <span>{deck.noteCount}</span>
          </div>
          {listBody()}
          {cards.length > 0 && (library?.offset > 0 || library?.hasMore) && (
            <div className="card-list-pager" style={{ display: 'flex', justifyContent: 'center', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
              <button className="back-btn" onClick={() => goToPage(-1)} disabled={!library?.offset || library.loading}>
                ← Prev
              </button>
              <small style={{ opacity: 0.75 }}>
                {(library?.offset || 0) + 1}–{(library?.offset || 0) + cards.length}
              </small>
              <button className="back-btn" onClick={() => goToPage(1)} disabled={!library?.hasMore || library.loading}>
                Next →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// The deck's two languages, shown as part of what the deck IS rather than as
// two dropdowns above every card you add to it.
const DeckLanguages = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <span className="deck-langs">
        {languageName(value.known)} &rarr; {languageName(value.learning)}
        <button type="button" onClick={() => setOpen(true)}>Change</button>
      </span>
    );
  }
  const codes = Object.keys(LANGUAGES);
  return (
    <span className="deck-langs">
      <select value={value.known} onChange={(e) => onChange({ ...value, known: e.target.value })} aria-label="Language you already know">
        {codes.map((c) => <option key={c} value={c}>{LANGUAGES[c].name}</option>)}
      </select>
      <span aria-hidden="true">&rarr;</span>
      <select value={value.learning} onChange={(e) => onChange({ ...value, learning: e.target.value })} aria-label="Language you are learning">
        {codes.map((c) => <option key={c} value={c}>{LANGUAGES[c].name}</option>)}
      </select>
      <button type="button" onClick={() => setOpen(false)}>Done</button>
    </span>
  );
};

export default CardList;
