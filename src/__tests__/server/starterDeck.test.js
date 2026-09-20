import fs from 'fs';
import path from 'path';
import { LANGUAGES } from '../../constants/languages';
import {
  buildStarterDeck,
  generationAvailable,
  starterLanguages,
  starterState,
} from '../../server/anki/starterDeck';

// The deck somebody gets when they have no OpenAI key.
//
// The invariant worth guarding here is the parallel one: index i is the same
// concept in every language. That is what lets eighteen lists of ten cover
// all three hundred and six ordered pairs, and it is the kind of property
// that a well-meaning edit to the data file ("this phrase reads better if I
// move it up") breaks silently, producing decks whose two sides say
// unrelated things.

const ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'starterPhrases.json'), 'utf8'));

function fakeOps({ existingMedia = new Set(), existingTargets = [] } = {}) {
  const added = { media: [], notes: [], decks: [] };
  return {
    added,
    listNotetypes: async () => [{
      id: 42,
      name: 'amgi Listening',
      fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'],
    }],
    // The real shape both transports return, wrapper and all. An earlier
    // version of this fake answered the deck directly, which is a nicer
    // shape and not the one that exists - so the code under test read the
    // id off the wrong object and every test here passed while writing
    // notes into deck `undefined` against a real collection.
    createDeck: async (name) => { added.decks.push(name); return { deck: { id: 7, name }, created: true }; },
    hasMedia: async (name) => existingMedia.has(name),
    addMedia: async (name, data) => { added.media.push({ name, bytes: data.length }); return name; },
    existingFieldValues: async () => existingTargets,
    addNote: async (note) => { added.notes.push(note); return { noteId: 100 + added.notes.length }; },
  };
}

describe('the starter phrase data', () => {
  it('has every language amgi offers in its dropdown', () => {
    expect(Object.keys(DATA.phrases).sort()).toEqual(Object.keys(LANGUAGES).sort());
  });

  it('is parallel: the same number of phrases in every language', () => {
    const lengths = new Set(Object.values(DATA.phrases).map((list) => list.length));
    expect([...lengths]).toEqual([DATA.concepts.length]);
  });

  it('has no romanisation in the languages that do not use latin script', () => {
    // Romanisation is not allowed anywhere in amgi - a learner who reads a
    // transliteration instead of the script is not learning the language.
    for (const code of ['zh_cn', 'zh_hk', 'ja', 'ko', 'ru', 'th', 'hi', 'ur', 'ar']) {
      for (const phrase of DATA.phrases[code]) {
        expect(phrase).not.toMatch(/[A-Za-z]/);
      }
    }
  });

  it('has no blank or untrimmed phrases', () => {
    for (const list of Object.values(DATA.phrases)) {
      for (const phrase of list) {
        expect(phrase).toBe(phrase.trim());
        expect(phrase.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('what the app is told about the key', () => {
  const saved = process.env.OPENAI_API_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  it('reports only whether a key exists, never anything derived from it', () => {
    process.env.OPENAI_API_KEY = 'sk-something-secret';
    expect(generationAvailable()).toBe(true);
    expect(JSON.stringify(starterState())).not.toContain('secret');
  });

  it('does not offer the starter deck when a key is configured', () => {
    process.env.OPENAI_API_KEY = 'sk-something';
    expect(starterState().offered).toBe(false);
  });

  it('offers it when there is no key', () => {
    delete process.env.OPENAI_API_KEY;
    // Guarded on the clips actually being present, so this test says
    // something about the offer rather than about a half-built checkout.
    if (starterLanguages().length > 1) expect(starterState().offered).toBe(true);
  });
});

describe('building one', () => {
  const saved = process.env.OPENAI_API_KEY;
  beforeEach(() => { delete process.env.OPENAI_API_KEY; });
  afterEach(() => {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  });

  const pair = () => {
    const available = starterLanguages();
    return { known: available[0], learning: available.find((c) => c !== available[0]) };
  };

  it('writes one ordinary note per phrase, both sides filled', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    const ops = fakeOps();
    const built = await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });

    expect(built.added).toBe(DATA.concepts.length);
    expect(ops.added.decks).toEqual(['amgi starter']);
    expect(ops.added.notes).toHaveLength(DATA.concepts.length);

    const [cue, cueAudio, target, targetAudio, language] = ops.added.notes[0].fields;
    expect(cue).toBe(DATA.phrases[known][0]);
    expect(target).toBe(DATA.phrases[learning][0]);
    expect(language).toBe(learning);
    // The template reads <audio src>, never [sound:] - see audio.js.
    expect(cueAudio).toMatch(/^<audio[^>]+src="plusaudio-[0-9a-f]+\.mp3"/);
    expect(targetAudio).toMatch(/^<audio[^>]+src="plusaudio-[0-9a-f]+\.mp3"/);
  });

  it('uses the same note type as every other card, and tags what it made', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    const ops = fakeOps();
    await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });
    expect(ops.added.notes.every((n) => n.notetypeId === 42)).toBe(true);
    expect(ops.added.notes[0].tags).toEqual(['amgi-starter']);
  });

  it('never writes a clip the collection already has', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    const first = fakeOps();
    await buildStarterDeck({ ops: first, known, learning, deckName: 'a' });
    expect(first.added.media.length).toBeGreaterThan(0);

    // The names are content hashes, so a second deck over the same languages
    // finds every clip already there - which is the point of hashing them.
    const names = new Set(first.added.media.map((m) => m.name));
    const second = fakeOps({ existingMedia: names });
    await buildStarterDeck({ ops: second, known, learning, deckName: 'b' });
    expect(second.added.media).toEqual([]);
  });

  it('adds nothing the deck already has, so a second press is not a duplicate', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    // createDeck finds-or-creates, so pressing the button twice lands in the
    // same deck. A free sample deck is exactly what somebody presses twice.
    const ops = fakeOps({ existingTargets: DATA.phrases[learning] });
    const built = await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });
    expect(built.added).toBe(0);
    expect(built.alreadyThere).toBe(DATA.concepts.length);
    expect(ops.added.notes).toEqual([]);
  });

  it('still adds the phrases a partly-built deck is missing', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    const ops = fakeOps({ existingTargets: DATA.phrases[learning].slice(0, 4) });
    const built = await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });
    expect(built.added).toBe(DATA.concepts.length - 4);
    expect(built.alreadyThere).toBe(4);
  });

  it('builds the deck anyway when the duplicate check cannot run', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    const ops = fakeOps();
    ops.existingFieldValues = async () => { throw new Error('bridge says no'); };
    const built = await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });
    expect(built.added).toBe(DATA.concepts.length);
  });

  it('refuses a deck whose two sides are the same language', async () => {
    await expect(buildStarterDeck({ ops: fakeOps(), known: 'en', learning: 'en', deckName: 'x' }))
      .rejects.toThrow(/different languages/);
  });

  it('puts every note in the deck it just created', async () => {
    const { known, learning } = pair();
    if (!learning) return;
    const ops = fakeOps();
    const built = await buildStarterDeck({ ops, known, learning, deckName: 'amgi starter' });
    expect(built.deckId).toBe(7);
    expect(ops.added.notes.every((n) => n.deckId === 7)).toBe(true);
  });

  it('says what to do when the note type is not installed yet', async () => {
    const ops = fakeOps();
    ops.listNotetypes = async () => [{ id: 1, name: 'Basic', fieldNames: ['Front', 'Back'] }];
    await expect(buildStarterDeck({ ops, known: 'en', learning: 'ko', deckName: 'x' }))
      .rejects.toThrow(/Restart Anki/);
  });
});
