import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaName } from 'plusaudio/lib/audio-store';
import { renderAudioReference } from 'plusaudio/lib/deck';
import { AMGI_NOTETYPE_NAME, fieldIndexes } from '../../utils/amgiNotetype';
import { existingKeySet, normalizeForDedupe } from '../../utils/lyricsParse';

// A deck you can have without paying for one.
//
// Everything else amgi makes costs an OpenAI call: a card is a translation
// plus two recordings, and there is no honest placeholder for either (see
// cardText.js on why generated text has no safe stub, unlike audio). So
// somebody who downloads amgi, installs the add-ons and has no key gets a
// working tool with nothing in it and no way to see what a finished card
// even looks like. This is the answer to that - ten real phrases with real
// recordings, in any pair of the languages amgi supports, built entirely
// from files that ship with the source.
//
// Two decisions make it small enough to be worth shipping.
//
// The phrases are PARALLEL. src/data/starterPhrases.json holds the same ten
// concepts in all eighteen languages, index for index, so a deck for any
// (known, learning) pair is assembled by taking index i from each of the two
// lists. Eighteen lists of ten cover all three hundred and six ordered
// pairs; eighteen SEPARATE top-ten lists would have covered none of them,
// because there would be nothing to put on the other side of the card.
//
// The clips are named by content, not by pair. plusaudio's mediaName()
// hashes (audio profile, language, text), which is the same name amgi's own
// generator would choose for that sentence - so a language's ten clips are
// recorded once and reused by every deck that language appears in, on either
// side, and a later real generation of the same sentence finds them already
// in the collection instead of paying to record them again.
//
// Nothing here is a special kind of note. These are ordinary notes on the
// ordinary amgi note type, with ordinary media, written through the same ops
// as every other note - which is what makes the starter deck a real deck the
// person can then edit, extend and delete like any other.

// Not named __dirname: this module is imported by a jest test, and jest
// transpiles ESM to CommonJS, where __dirname is already a binding - the
// redeclaration is a syntax error before a single test runs.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..', '..');
const PHRASE_FILE = path.join(ROOT, 'src', 'data', 'starterPhrases.json');
const MEDIA_DIR = path.join(ROOT, 'anki', 'starter', 'media');

let cached = null;

function phraseData() {
  if (cached) return cached;
  if (!fs.existsSync(PHRASE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(PHRASE_FILE, 'utf8'));
    if (!parsed || typeof parsed.phrases !== 'object') return null;
    cached = parsed;
    return cached;
  } catch {
    return null;
  }
}

/**
 * Can a real OpenAI call be made at all?
 *
 * The only thing the browser is ever told about the key: whether one is
 * configured. Never its value, never its length, never a masked form of it -
 * a boolean cannot leak anything, and nothing on the client needs more.
 */
export function generationAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Which languages a starter deck can be built in - the intersection of what
 * has phrases and what has every one of its clips recorded.
 *
 * A language missing even one clip is left out entirely rather than offered
 * with a silent hole in it: the point of this deck is to show what a
 * finished card is, and a card with no audio is exactly the thing amgi is
 * for and cannot demonstrate.
 */
export function starterLanguages() {
  const data = phraseData();
  if (!data) return [];
  return Object.keys(data.phrases)
    .filter((code) => {
      const list = data.phrases[code];
      return Array.isArray(list)
        && list.length > 0
        && list.every((text) => fs.existsSync(path.join(MEDIA_DIR, mediaName(text, code))));
    })
    .sort();
}

/** What the setup screen needs to decide whether to offer this at all. */
export function starterState() {
  const languages = starterLanguages();
  return {
    // Offered only when there is no key. With a key, the person can make
    // their own cards about whatever they actually want to learn, and a
    // fixed ten phrases would be a worse first deck than one of those.
    offered: !generationAvailable() && languages.length > 1,
    generationAvailable: generationAvailable(),
    languages,
    phraseCount: phraseData()?.concepts?.length || 0,
  };
}

/**
 * Build one starter deck in `ops`' collection.
 *
 * Returns what was made rather than throwing on a partial result: a clip
 * that will not write is worth reporting, but it is not worth discarding the
 * nine cards that did.
 */
export async function buildStarterDeck({ ops, known, learning, deckName }) {
  const data = phraseData();
  if (!data) throw new Error('This copy of amgi has no starter phrases in it.');
  if (known === learning) throw new Error('Pick two different languages.');

  const cues = data.phrases[known];
  const targets = data.phrases[learning];
  if (!Array.isArray(cues) || !Array.isArray(targets)) {
    throw new Error('amgi has no starter phrases for that pair of languages.');
  }

  const notetypes = await ops.listNotetypes();
  const notetype = notetypes.find((nt) => nt.name === AMGI_NOTETYPE_NAME);
  if (!notetype) {
    throw new Error(`Restart Anki once so it adds the "${AMGI_NOTETYPE_NAME}" card type, then try again.`);
  }
  const idx = fieldIndexes(notetype);

  // createDeck answers {deck, created} on both transports, not the deck -
  // it has to, because "created" is the half that says whether a name
  // already existed. Reading `.id` off the wrapper instead gave every note
  // an undefined deck id, which surfaces as "cannot be bound to SQLite
  // parameter 3" from inside the insert, naming neither the deck nor the
  // field it came from.
  // createDeck answers {deck, created} on both transports, not the deck -
  // it has to, because "created" is the half that says whether a name
  // already existed. Reading `.id` off the wrapper instead gave every note
  // an undefined deck id, which surfaces as "cannot be bound to SQLite
  // parameter 3" from inside the insert, naming neither the deck nor the
  // field it came from.
  const { deck } = await ops.createDeck(deckName);

  // createDeck finds-or-creates, so a second press on the same pair lands in
  // the deck the first press made. Without this, it lands there and adds the
  // same ten phrases again - and a free sample deck is exactly the thing
  // somebody presses twice, because nothing on screen tells them what the
  // first press did until they look in Anki.
  let already = new Set();
  if (idx.target >= 0) {
    try {
      already = existingKeySet(await ops.existingFieldValues(deck.id, notetype.id, idx.target));
    } catch {
      // A dedupe check that will not run is not a reason to refuse to build
      // the deck; the worst case is the duplicate this was trying to avoid.
    }
  }

  const count = Math.min(cues.length, targets.length);
  const added = [];
  const skipped = [];
  let duplicates = 0;

  for (let i = 0; i < count; i += 1) {
    if (already.has(normalizeForDedupe(targets[i]))) {
      duplicates += 1;
      continue;
    }
    const fields = notetype.fieldNames.map(() => '');
    if (idx.cue >= 0) fields[idx.cue] = cues[i];
    if (idx.target >= 0) fields[idx.target] = targets[i];
    if (idx.language >= 0) fields[idx.language] = learning;

    const cueClip = await attachClip(ops, cues[i], known);
    const targetClip = await attachClip(ops, targets[i], learning);
    if (idx.cueAudio >= 0 && cueClip) fields[idx.cueAudio] = cueClip;
    if (idx.targetAudio >= 0 && targetClip) fields[idx.targetAudio] = targetClip;
    if (!cueClip || !targetClip) skipped.push(targets[i]);

    const note = await ops.addNote({
      deckId: deck.id,
      notetypeId: notetype.id,
      fields,
      tags: ['amgi-starter'],
      language: learning,
      learningFieldIndex: idx.target >= 0 ? idx.target : undefined,
    });
    added.push(note?.noteId ?? null);
  }

  return { deckId: deck.id, deckName, added: added.length, alreadyThere: duplicates, missingAudio: skipped };
}

/**
 * Put one shipped clip into the collection's media and return the reference
 * a field holds, or '' when this build has no such clip.
 *
 * `hasMedia` first, because the name is a content hash: a collection that
 * already has this exact sentence in this exact language already has this
 * exact file, whether it came from a previous starter deck or from a real
 * generation, and writing it again is bytes AnkiWeb would have to sync for
 * no change at all.
 */
async function attachClip(ops, text, language) {
  const name = mediaName(text, language);
  if (await ops.hasMedia(name)) return renderAudioReference(name, 'html');
  const source = path.join(MEDIA_DIR, name);
  if (!fs.existsSync(source)) return '';
  const stored = await ops.addMedia(name, fs.readFileSync(source));
  return renderAudioReference(stored, 'html');
}
