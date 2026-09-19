import React from 'react';
import { useDecks } from '../../contexts/DeckContext';
import { useRouter } from 'next/navigation';
import { SparklesIcon, TrashIcon, ArrowUpTrayIcon } from '@heroicons/react/24/outline';
import msgpack from 'msgpack-lite';
import './DeckItem.css';

const DeckItem = ({ id, deck }) => {
  const {
    deleteDeck,
    setCurrentDeckId,
    audioBackfill,
    startAudioBackfill,
  } = useDecks();

  const router = useRouter();
  const backfill = audioBackfill?.[id];

  const handleEditClick = (e, id) => {
    console.log('Edit deck clicked:', id);
    e.stopPropagation();
    setCurrentDeckId(id);
    router.push(`/deck/${id}/edit`);
  };

  const handleDeckClick = (id) => {
    setCurrentDeckId(id);
    router.push(`/deck/${id}/review`);
  };

  const handleDeleteClick = (e) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this deck?')) {
      deleteDeck(id);
    }
  };

  const handleExportClick = async (e) => {
    e.stopPropagation();
    try {
      // Encode deck data using MessagePack for smaller file size
      const encoded = msgpack.encode(deck);
      const blob = new Blob([encoded], { type: 'application/x-msgpack' });
      
      try {
        // Use the file system access API if available
        const handle = await window.showSaveFilePicker({
          suggestedName: `${deck.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.bin`,
          types: [{
            description: 'Flashcard Deck',
            accept: {
              'application/x-msgpack': ['.bin']
            }
          }]
        });
        
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (fsErr) {
        // Only fallback if the API is not supported
        if (fsErr.name !== 'AbortError') {
          console.log('Falling back to legacy download method:', fsErr);
          const a = document.createElement('a');
          const url = URL.createObjectURL(blob);
          a.href = url;
          a.download = `${deck.name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}.bin`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      }
    } catch (err) {
      console.error('Error exporting deck:', err);
      alert('Failed to export deck: ' + err.message);
    }
  };

  return (
    <div 
      className="deck-item"
      onClick={() => handleDeckClick(id)}
    >
      <div className="deck-info">
        <h3>{deck.name}</h3>
        <small>
          {/* Not the deck's size: `deck.cards` is the review queue, capped and
              filtered to what today's session serves. The deck's own page is
              where the whole deck is listed. */}
          {deck.cards.length} to study today (
          <span className="learning-count">{deck.cards.filter(card => card.review?.card_state === 'learning').length} learning</span> • {' '}
          <span className="new-count">{deck.cards.filter(card => card.review?.card_state === 'new').length} new</span> • {' '}
          <span className="review-count">{deck.cards.filter(card => card.review?.card_state === 'review').length} review</span>)
        </small>
        {backfill?.running && (
          <small style={{ display: 'block', marginTop: '0.25rem', opacity: 0.75 }}>
            🎙 Generating audio… {backfill.done}/{backfill.total}
          </small>
        )}
        {!backfill?.running && backfill?.error && (
          <small style={{ display: 'block', marginTop: '0.25rem', color: '#e07050' }}>
            Audio generation stopped: {backfill.error}{' '}
            <button
              onClick={(e) => { e.stopPropagation(); startAudioBackfill(id); }}
              style={{ textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0 }}
            >
              Retry
            </button>
          </small>
        )}
      </div>
      <div className="deck-item-actions">
        <button 
          onClick={(e) => handleEditClick(e, id)}
          className="icon-btn"
          title="Edit Deck"
        >
          <SparklesIcon className="icon" />
        </button>
        <button 
          onClick={handleExportClick}
          className="icon-btn"
          title="Export Deck"
        >
          <ArrowUpTrayIcon className="icon" />
        </button>
        <button 
          onClick={handleDeleteClick}
          className="icon-btn"
          title="Delete Deck"
        >
          <TrashIcon className="icon" />
        </button>
      </div>
    </div>
  );
};

export default DeckItem; 