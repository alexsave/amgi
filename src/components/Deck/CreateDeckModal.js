import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import LANGUAGES from '../../constants/languages';

const CreateDeckModal = ({ isOpen, onClose, onSubmit }) => {
  const [deckName, setDeckName] = useState('');
  const [knownLanguage, setKnownLanguage] = useState('en');
  const [learningLanguage, setLearningLanguage] = useState('ko');

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({
      name: deckName,
      knownLanguage,
      learningLanguage
    });
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
            <label htmlFor="deckName">Deck Name</label>
            <input
              id="deckName"
              type="text"
              value={deckName}
              onChange={(e) => setDeckName(e.target.value)}
              placeholder="Enter deck name"
              autoFocus
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="knownLanguage">I know</label>
            <select
              id="knownLanguage"
              value={knownLanguage}
              onChange={(e) => setKnownLanguage(e.target.value)}
              className="language-select"
            >
              {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
                <option key={code} value={code}>
                  {flag} {name}
                </option>
              ))}
            </select>
          </div>
          
          <div className="form-group">
            <label htmlFor="learningLanguage">I want to learn</label>
            <select
              id="learningLanguage"
              value={learningLanguage}
              onChange={(e) => setLearningLanguage(e.target.value)}
              className="language-select"
            >
              {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
                <option key={code} value={code}>
                  {flag} {name}
                </option>
              ))}
            </select>
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