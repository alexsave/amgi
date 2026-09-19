import React, { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useDecks } from '../../contexts/DeckContext';
import CardForm from './CardForm';
import './CardList.css';

const PAGE_SIZE = 20;

const CardList = () => {
  const { id } = useParams();
  const router = useRouter();
  const { decks, deckCards, loadDeckCards, setCurrentDeckId } = useDecks();

  const deck = decks[id];

  useEffect(() => {
    loadDeckCards(id, { offset: 0, limit: PAGE_SIZE });
  }, [id, loadDeckCards]);

  const library = deckCards[id];
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
      <div className="card-list">
        {cards.map((cardData) => (
          <div key={cardData.id} className="card-item">
            <div className="card-item-header">
              <span>{cardData.notetypeName}</span>
            </div>
            <small>{cardData.front_text}</small>
            <small style={{ display: 'block', opacity: 0.7, marginTop: '0.15rem' }}>
              {cardData.hasAudio ? '🔊 has audio' : 'no audio yet'}
            </small>
            <div className="card-stats">
              <small>Scheduled in Anki</small>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="deck-cards">
      <div className="deck-cards-header">
        <button onClick={handleBack} className="back-btn">← Back</button>
        <h1>{deck.name}</h1>
        <p className="language-info">{deck.noteCount} note{deck.noteCount === 1 ? '' : 's'} in your Anki collection</p>
      </div>

      <div className="deck-content">
        <CardForm deckId={id} />

        <div className="deck-cards-list">
          <h3>Notes in Deck{deck.noteCount ? ` (${deck.noteCount})` : ''}</h3>
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

export default CardList;
