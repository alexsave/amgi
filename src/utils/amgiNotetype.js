// The note type amgi installs, and how to find its fields.
//
// This lives here rather than in a component because two different screens
// need it and neither owns it. It used to be exported from CardForm, which
// looked harmless until a test mocked that component away and every row in
// the deck list silently decided it was not an amgi card - the constant came
// back undefined, so the comparison was false for everything. A fact about
// the collection does not belong inside a component that renders one form.

export const AMGI_NOTETYPE_NAME = 'amgi Listening';

// Addressed by name, never by index: a learner is free to add fields of their
// own, and the add-on's installer deliberately never removes or reorders what
// it finds (see anki/addon/amgi_bridge/notetype.py).
const FIELD = {
  cue: 'Cue',
  cueAudio: 'CueAudio',
  target: 'Target',
  targetAudio: 'TargetAudio',
  language: 'Language',
  notes: 'Notes',
};

/** Where each amgi field sits on this note type, or -1 when it is absent. */
export function fieldIndexes(notetype) {
  const names = notetype?.fieldNames || [];
  const at = (name) => names.findIndex((n) => n.toLowerCase() === name.toLowerCase());
  return {
    cue: at(FIELD.cue),
    cueAudio: at(FIELD.cueAudio),
    target: at(FIELD.target),
    targetAudio: at(FIELD.targetAudio),
    language: at(FIELD.language),
    notes: at(FIELD.notes),
  };
}
