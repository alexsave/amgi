// The seam between the app and the anki/ card template: a note the app writes has to be one the
// template can play, with the right clip in the right field. Neither side's own tests catch a drift
// on their own: the app finds the amgi fields by name (ui/src/fields.c, amgi_fields_of), the
// template reads them by name (anki/notetype/*.html), and the clips are rendered by
// the clip names and references server/amgi/web.c makes. This holds the three to each other, reading the real template files, not
// another copy of the same assumption. Run ui/build.sh first (it builds ui/out/text_dump).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sandboxEnv } from '../../test/sandbox-home.cjs';


// A clip is named by a hash of (text, language), recorded from the JavaScript naming this was ported
// from (the same names server/amgi/web.c and the add-on's deck_text.py make).
const CLIP_NAMES = new Map([
  ['I am a little tired today.\0en', 'plusaudio-9867373d43306191c93c.wav'],
  ['오늘 저는 조금 피곤해요.\0ko', 'plusaudio-afdb21e134c02ce3dedd.wav'],
]);
const mediaName = (text, language) => CLIP_NAMES.get(`${text}\0${language}`);
const renderAudioReference = (name) => `<audio src="${name}"></audio>`;
const audioReferences = (field) =>
  [...field.matchAll(/<audio\s+src="([^"]+)"[^>]*><\/audio>/g)].map((m) => ({ name: m[1], form: 'html' }));

const ROOT = path.join(import.meta.dirname, '..', '..');
const dump = path.join(ROOT, 'ui', 'out', 'text_dump');

// One call through the C: (u32 function, u32 length, bytes) in, (u32 length, bytes) out.
function c(fn, s) {
  const b = Buffer.from(s, 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(fn, 0);
  head.writeUInt32LE(b.length, 4);
  const out = execFileSync(dump, { env: sandboxEnv(), input: Buffer.concat([head, b]) });
  return out.subarray(4, 4 + out.readUInt32LE(0)).toString('utf8');
}
const NAMES = c(9, '').split('\x1f');
const fieldsOf = (names) => {
  const [cue, cueAudio, target, targetAudio, language, notes] = c(8, names.join('\x1f')).split(',').map(Number);
  return { cue, cueAudio, target, targetAudio, language, notes };
};

/** Every {{Field}} (and {{#Field}}) the template's own markup reads. */
function fieldsReferencedBy(templateFile) {
  const html = fs.readFileSync(path.join(ROOT, 'anki', 'notetype', templateFile), 'utf8');
  return new Set([...html.matchAll(/\{\{#?(\w+)\}\}/g)].map((m) => m[1]));
}

// The note type's field order, exactly as anki/README.md's install step documents it.
const ORDER = ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'];

describe('a note the app writes for the amgi Listening note type', () => {
  test('the names the app looks for are the names the templates read', () => {
    assert.deepEqual(NAMES, ORDER);
    // The front side renders only CueAudio (front.html says why the answer text may never appear there).
    assert.deepEqual(fieldsReferencedBy('front.html'), new Set(['CueAudio']));
    const back = fieldsReferencedBy('back.html');
    for (const name of ['Cue', 'CueAudio', 'Target', 'TargetAudio']) assert.equal(back.has(name), true, name);
    for (const name of [...fieldsReferencedBy('front.html'), ...back]) assert.equal(NAMES.includes(name), true, name);
  });

  test('each field is found by its name, never by its position, and case folded', () => {
    assert.deepEqual(fieldsOf(ORDER), { cue: 0, cueAudio: 1, target: 2, targetAudio: 3, language: 4, notes: 5 });
    const moved = ['notes', 'TARGETAUDIO', 'target', 'Language', 'cueaudio', 'Cue'];
    assert.deepEqual(fieldsOf(moved), { cue: 5, cueAudio: 4, target: 2, targetAudio: 1, language: 3, notes: 0 });
    assert.deepEqual(fieldsOf(['Front', 'Back']), { cue: -1, cueAudio: -1, target: -1, targetAudio: -1, language: -1, notes: -1 });
  });

  test('CueAudio gets the known-language clip and TargetAudio the learning-language one, as html references', () => {
    const at = fieldsOf(ORDER);
    const known = ['I am a little tired today.', 'en'];
    const learning = ['오늘 저는 조금 피곤해요.', 'ko'];
    const fields = ORDER.map(() => '');
    fields[at.cue] = known[0];
    fields[at.target] = learning[0];
    fields[at.cueAudio] = renderAudioReference(mediaName(...known), 'html');
    fields[at.targetAudio] = renderAudioReference(mediaName(...learning), 'html');

    const cueRefs = audioReferences(fields[at.cueAudio]);
    const targetRefs = audioReferences(fields[at.targetAudio]);
    assert.equal(cueRefs.length, 1);
    assert.equal(targetRefs.length, 1);
    // html, never [sound:...]: Anki strips a sound tag before any template JavaScript runs, so the
    // card template cannot see one, and a regression would look fine in the editor and play nothing.
    assert.equal(cueRefs[0].form, 'html');
    assert.equal(targetRefs[0].form, 'html');
    assert.doesNotMatch(fields[at.cueAudio], /\[sound:/);
    // A filename is a hash of (text, language), so these match only if each side was spoken in its own language.
    assert.equal(cueRefs[0].name, mediaName(...known));
    assert.equal(targetRefs[0].name, mediaName(...learning));
    assert.notEqual(cueRefs[0].name, targetRefs[0].name);
  });
});
