import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { useDecks } from '../../contexts/DeckContext';
import { useRouter } from 'next/navigation';

const CreateDeckModal = ({ isOpen, setIsCreateModalOpen }) => {
  const [deckName, setDeckName] = useState('');
  const [error, setError] = useState('');
  const router = useRouter();

  const { createNewDeck, setCurrentDeckId } = useDecks();

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!deckName.trim()) {
      setError('Enter a deck name');
      return;
    }
    setError('');
    try {
      const id = await createNewDeck({ name: deckName.trim() });
      setCurrentDeckId(id);
      setIsCreateModalOpen(false);
      setDeckName('');
      router.push(`/deck/${id}`);
    } catch (err) {
      console.error('Error creating deck:', err);
      setError('Failed to create deck: ' + err.message);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Create New Deck</h3>
          <button onClick={() => setIsCreateModalOpen(false)} className="close-btn">
            <XMarkIcon className="icon" />
          </button>
        </div>
        <form onSubmit={handleSubmit} autoComplete="off">
          <div className="form-group">
            <label htmlFor="deckName">Deck Name</label>
            <input
              id="deckName"
              type="text"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="e.g. Korean::Verbs"
              autoFocus
            />
            <small style={{ display: 'block', marginTop: '0.35rem', opacity: 0.75 }}>
              Use <code>::</code> to nest under a parent deck (created automatically if it does not exist yet).
            </small>
          </div>

          {error && <div className="error-message">{error}</div>}

          <div className="button-row">
            <button type="submit" className="primary-btn">
              Create Deck
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateDeckModal;
