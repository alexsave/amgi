import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import LANGUAGES from '../../constants/languages';
import { useDecks } from '../../contexts/DeckContext';
import { useRouter } from 'next/navigation';

const CreateDeckModal = ({ isOpen, setIsCreateModalOpen }) => {
  const [deckName, setDeckName] = useState('');
  const [known_language, setKnownLanguage] = useState('en');
  const [learning_language, setLearningLanguage] = useState('ko');
  const router = useRouter();

  const { 
    createNewDeck,
    setCurrentDeckId,
  } = useDecks();

  if (!isOpen) return null;

  const handleSubmit = async (e) => {
    e.preventDefault();

    const finalDeckName = deckName.trim() === '' 
      ? `${LANGUAGES[known_language].name} -> ${LANGUAGES[learning_language].name}`
      : deckName;

    console.log('Creating new deck with name:', finalDeckName);
    try {
      console.log('Calling createNewDeck...');
      const id = await createNewDeck({
        name: finalDeckName,
        known_language,
        learning_language
      });
      console.log('Created deck with ID:', id);
      setCurrentDeckId(id);
      
      setIsCreateModalOpen(false);
      console.log('Navigating to deck page...');
      router.push(`/deck/${id}/edit`);
    } catch (error) {
      console.error('Error creating deck:', error);
      alert('Failed to create deck: ' + error.message);
    }

    setDeckName('');
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
              placeholder="Enter deck name"
              autoFocus
            />
          </div>
          
          <div className="form-group">
            <label htmlFor="known_language">I know</label>
            <select
              id="known_language"
              value={known_language}
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
            <label htmlFor="learning_language">I want to learn</label>
            <select
              id="learning_language"
              value={learning_language}
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