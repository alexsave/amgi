import React, { useState } from 'react';
import { ankiApi } from '../../utils/ankiApi';
import AudioChip from './AudioChip';
import './CardPanel.css';

// One card, editable, wherever a card is shown on its own.
//
// The same component serves the card you just made and a card you opened out
// of the deck, because they are the same thing: the card is already in Anki
// either way, so "make" and "edit" differ only in how you got here. That is
// also why there is no Save button - a field writes itself back when you
// leave it, and only if it actually changed.
//
// Fields are addressed by name (Cue, Target, Notes and their audio
// counterparts) rather than by index, and a name that is not on this note
// type is simply not rendered, so a learner who added a field of their own
// does not break the panel.

const LABEL_FIELDS = ['target', 'cue', 'notes'];

const CardPanel = ({ noteId, notetype, idx, initialFields, languages, onDeleted, onFieldsChange, footer }) => {
  // Keyed by note id rather than synced from the prop in an effect: moving to
  // another card is a different card, so React remounting the state is
  // exactly right, and it avoids a render that shows the previous card's text
  // under the new card's heading.
  const [fields, setFields] = useState(initialFields);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const value = (key) => (idx[key] >= 0 ? fields[idx[key]] || '' : '');

  const commit = async (key, next) => {
    if (idx[key] < 0 || next === fields[idx[key]]) return;
    const updated = fields.slice();
    updated[idx[key]] = next;
    setFields(updated);
    if (onFieldsChange) onFieldsChange(updated);
    try {
      await ankiApi.updateNote(noteId, updated, {
        language: languages.learning,
        learningFieldIndex: idx.target >= 0 ? idx.target : undefined,
      });
    } catch (err) {
      setError(err.message);
    }
  };

  // Re-record one side. The text is whatever is in the field right now, so
  // this doubles as "I edited the sentence, make the audio match".
  const redo = async (side) => {
    const textKey = side === 'target' ? 'target' : 'cue';
    const audioKey = side === 'target' ? 'targetAudio' : 'cueAudio';
    const text = value(textKey).replace(/<[^>]*>/g, '').trim();
    if (!text || idx[audioKey] < 0) return;
    setBusy(side);
    setError('');
    try {
      const language = side === 'target' ? languages.learning : languages.known;
      const clip = await ankiApi.generateAudio(text, language, { fresh: true });
      const updated = fields.slice();
      updated[idx[audioKey]] = clip.reference;
      setFields(updated);
      if (onFieldsChange) onFieldsChange(updated);
      await ankiApi.updateNote(noteId, updated, {
        language: languages.learning,
        learningFieldIndex: idx.target >= 0 ? idx.target : undefined,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    // One confirmation, naming what goes: this deletes from a collection that
    // syncs, so it is gone from every device, review history included.
    const text = value('target').replace(/<[^>]*>/g, '').trim();
    if (!window.confirm(`Delete this card?\n\n${text}\n\nIts review history goes too, on every device you sync with.`)) return;
    setDeleting(true);
    try {
      await ankiApi.deleteNote(noteId);
      if (onDeleted) onDeleted(noteId);
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  const clip = (key) => {
    const raw = idx[key] >= 0 ? fields[idx[key]] || '' : '';
    const match = /<audio[^>]*\ssrc\s*=\s*["']([^"']+)["']/i.exec(raw);
    return match ? match[1] : '';
  };

  const labels = {
    target: languages.learningName,
    cue: languages.knownName,
    notes: 'Notes',
  };

  return (
    <div className="card-panel">
      <div className="card-panel-fields">
        {LABEL_FIELDS.map((key) => (
          idx[key] >= 0 && (
            <label className="card-panel-field" key={key}>
              <span className="card-panel-label">
                {labels[key]}
                {key === 'notes' && <em> optional</em>}
              </span>
              <input
                type="text"
                className={key === 'target' ? 'card-panel-value card-panel-value-big' : 'card-panel-value'}
                defaultValue={value(key)}
                placeholder={key === 'notes' ? 'anything you want on the answer' : ''}
                onBlur={(e) => commit(key, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur(); }}
              />
            </label>
          )
        ))}
      </div>

      <div className="card-panel-clips">
        <AudioChip filename={clip('cueAudio')} label={languages.knownName} tone="cue" />
        <AudioChip filename={clip('targetAudio')} label={languages.learningName} tone="target" />
        <button type="button" className="card-panel-redo" onClick={() => redo('target')} disabled={busy !== ''}>
          {busy === 'target' ? 'Redoing…' : `Redo ${languages.learningName}`}
        </button>
        <button type="button" className="card-panel-redo" onClick={() => redo('cue')} disabled={busy !== ''}>
          {busy === 'cue' ? 'Redoing…' : `Redo ${languages.knownName}`}
        </button>
      </div>

      {error && <p className="card-panel-error">{error}</p>}

      <div className="card-panel-foot">
        <span>{footer}</span>
        <button type="button" className="card-panel-delete" onClick={remove} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete card'}
        </button>
      </div>
    </div>
  );
};

export default CardPanel;
