import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { STARTER_DECKS } from '../../data/starterDecks';
import { getLanguageDisplay } from '../../constants/languages';
import { useDecks } from '../../contexts/DeckContext';
import { useNavigate } from 'react-router-dom';

/**
 * Lets a new user create a ready-made deck of common phrases in one click.
 * Cards appear immediately; audio generates in the background (progress is
 * shown on the deck card in the list).
 */
const StarterDeckModal = ({ isOpen, onClose }) => {
  const [creatingId, setCreatingId] = useState(null);
  const { createDeckFromTemplate } = useDecks();
  const navigate = useNavigate();

  if (!isOpen) return null;

  const handleCreate = async (template) => {
    if (creatingId) return;
    setCreatingId(template.id);
    try {
      await createDeckFromTemplate(template);
      onClose();
      navigate('/decks');
    } catch (error) {
      console.error('Error creating starter deck:', error);
      alert('Failed to create starter deck: ' + error.message);
    } finally {
      setCreatingId(null);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Starter Decks</h3>
          <button onClick={onClose} className="close-btn">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <p style={{ margin: '0 0 1rem', opacity: 0.75, fontSize: '0.9rem' }}>
          Ready-made decks of common phrases. Audio for each card is generated
          in the background after the deck is created (2 audio generations per
          card count toward your plan).
        </p>
        <div className="starter-deck-list">
          {STARTER_DECKS.map((template) => (
            <button
              key={template.id}
              className="starter-deck-option"
              onClick={() => handleCreate(template)}
              disabled={!!creatingId}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '0.75rem', marginBottom: '0.5rem', borderRadius: '8px',
                cursor: creatingId ? 'wait' : 'pointer'
              }}
            >
              <strong>
                {getLanguageDisplay(template.learning_language).flag} {template.name}
              </strong>
              {' '}<span style={{ opacity: 0.6 }}>· {template.cards.length} cards</span>
              <div style={{ fontSize: '0.85rem', opacity: 0.75, marginTop: '0.25rem' }}>
                {creatingId === template.id ? 'Creating deck…' : template.description}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default StarterDeckModal;
