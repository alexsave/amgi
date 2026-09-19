import React, { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { TrashIcon } from '@heroicons/react/24/outline';
import { useDecks } from '../../contexts/DeckContext';
import CardForm from './CardForm';
import CardModal from './CardModal';
import './CardList.css';
import { getLanguageDisplay } from '../../constants/languages';

// What a card's schedule looks like to someone browsing the deck. The stored
// shape is the review row (snake_case, days), not the camelCase fields this
// block used to read - which is why it never rendered at all.
const CardSchedule = ({ review }) => {
  if (!review || review.card_state === 'new') {
    return (
      <div className="card-stats">
        <small>New - not studied yet</small>
      </div>
    );
  }

  const due = review.next_review_date ? new Date(review.next_review_date) : null;
  const dueLabel = due && !isNaN(due.getTime()) ? due.toLocaleDateString() : 'unscheduled';

  return (
    <div className="card-stats">
      <small>
        {review.card_state === 'learning' ? 'Learning' : 'Review'} · Due {dueLabel}
        <br />
        Interval: {review.interval_days ?? 0} day{review.interval_days === 1 ? '' : 's'}
        {typeof review.ease_factor === 'number' && <> · Ease: {review.ease_factor.toFixed(2)}</>}
        {review.lapses > 0 && <> · Lapses: {review.lapses}</>}
      </small>
    </div>
  );
};

const CardList = ({ onCardClick }) => {
  const { id } = useParams();
  const router = useRouter();
  const { decks, deckCards, loadDeckCards, setCurrentDeckId, deleteCard } = useDecks();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [deletingCardId, setDeletingCardId] = useState(null);

  const deck = decks[id];

  // Browsing a deck reads the deck, not the review queue: `deck.cards` only
  // holds what today's session would serve.
  useEffect(() => {
    loadDeckCards(id);
  }, [id, loadDeckCards]);

  const library = deckCards[id];
  const cards = library?.cards || [];

  const handleBack = () => {
    setCurrentDeckId(null);
    router.push('/decks');
  };

  const closeModal = () => setIsModalOpen(false);
  const handleGenerationStart = () => setIsModalOpen(true);

  // Confirmed the same way a deck deletion is, and the row stays disabled
  // until the server has actually removed the card and its audio.
  const handleDeleteClick = async (e, cardData) => {
    e.stopPropagation();
    if (!window.confirm(`Delete this card?\n\n${cardData.front_text}`)) return;

    setDeletingCardId(cardData.id);
    try {
      await deleteCard(id, cardData.id);
    } catch (err) {
      console.error('Error deleting card:', err);
      alert(`Failed to delete card: ${err.message}`);
    } finally {
      setDeletingCardId(null);
    }
  };

  const listBody = () => {
    if (library?.error) {
      return (
        <div className="empty-deck">
          <p>Could not load this deck&apos;s cards: {library.error}</p>
        </div>
      );
    }

    // Only say the deck is empty once a read has actually come back, so a slow
    // network never claims the cards are gone.
    if (cards.length === 0) {
      return (
        <div className="empty-deck">
          <p>{library && !library.loading ? 'No cards in this deck yet.' : 'Loading cards…'}</p>
        </div>
      );
    }

    return (
      <div className="card-list">
        {cards.map((cardData, index) => (
          <div
            key={cardData.id}
            className={`card-item${onCardClick ? ' is-clickable' : ''}`}
            onClick={onCardClick ? () => onCardClick(cardData) : undefined}
          >
            <div className="card-item-header">
              <span>Card {index + 1}</span>
              <button
                onClick={(e) => handleDeleteClick(e, cardData)}
                className="card-delete-btn"
                title="Delete Card"
                disabled={deletingCardId === cardData.id}
              >
                <TrashIcon className="icon" />
              </button>
            </div>
            <small>{cardData.front_text}</small>
            <CardSchedule review={cardData.review} />
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
        <p className="language-info">
          {getLanguageDisplay(deck.known_language).flag} {getLanguageDisplay(deck.known_language).name} → {getLanguageDisplay(deck.learning_language).flag} {getLanguageDisplay(deck.learning_language).name}
        </p>
      </div>

      <div className="deck-content">
        <CardForm onGenerationStart={handleGenerationStart} />

        <div className="deck-cards-list">
          <h3>Cards in Deck{cards.length > 0 ? ` (${cards.length})` : ''}</h3>
          {listBody()}
        </div>
      </div>

      <CardModal isOpen={isModalOpen} onClose={closeModal} />
    </div>
  );
};

export default CardList;
