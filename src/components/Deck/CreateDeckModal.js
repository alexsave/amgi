import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';

const CreateDeckModal = ({ isOpen, onClose, onSubmit }) => {
  const [deckName, setDeckName] = useState('');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(deckName);
    setDeckName('');
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content">
        <div className="modal-header">
          <h3>Create New Deck</h3>
          <button onClick={onClose} className="close-btn">
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} autoComplete="off">
          <div className="form-group">
            <input
              id="deckName"
              type="text"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="Enter deck name"
              autoFocus
            />
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose} className="cancel-btn">
              Cancel
            </button>
            <button type="submit" className="submit-btn" disabled={!deckName.trim()}>
              Create Deck
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateDeckModal;