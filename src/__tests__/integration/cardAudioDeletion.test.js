/**
 * @jest-environment node
 *
 * Deleting cards must take their audio with it, but must never take audio a
 * surviving card still points at. The seeded deck does not share audio between
 * a translation pair, so every fixture here is built on purpose: a pair is two
 * rows referencing the same two objects, crosswise.
 *
 * These run against the LOCAL Supabase stack, through the same module the
 * `delete-cards` edge function calls, with the service role - so the objects
 * are uploaded the way production uploads them (owner null), which is the case
 * a client-side remove() silently fails to delete.
 */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { deleteCardsAndAudio, CARD_AUDIO_BUCKET } = require('../../../supabase/functions/_shared/cardDeletion.ts');

const ENV_FILE = path.join(process.cwd(), '.e2e', 'local-supa.env');
const TEST_EMAIL = 'test@amgi.cards';

const readLocalEnv = () => {
  if (!fs.existsSync(ENV_FILE)) return null;
  const env = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_0-9]+)="?([^"]*)"?$/);
    if (match) env[match[1]] = match[2];
  }
  if (!env.API_URL || !env.API_URL.includes('127.0.0.1')) return null;
  return env;
};

const localEnv = readLocalEnv();

// Skipping rather than failing keeps `pnpm test` useful without Docker, but
// says so loudly: these are the tests that cover the shared-audio case.
const describeLocal = localEnv ? describe : describe.skip;
if (!localEnv) {
  console.warn(
    `[cardAudioDeletion] SKIPPED: no local Supabase at ${ENV_FILE}.\n` +
    '  Run `supabase start && supabase status -o env > .e2e/local-supa.env` to run them.'
  );
}

describeLocal('deleting cards and their audio', () => {
  let admin;
  let userId;
  const prefix = `gctest_${Date.now()}`;
  const createdDeckIds = [];
  const uploadedPaths = [];

  // Objects are uploaded with the service role on purpose: that is how
  // supabase/functions/cards/index.ts uploads real card audio, and it leaves
  // storage.objects.owner null.
  const upload = async (label) => {
    const objectPath = `${prefix}_${label}.mp3`;
    const { error } = await admin.storage
      .from(CARD_AUDIO_BUCKET)
      .upload(objectPath, Buffer.from(`audio for ${label}`), { contentType: 'audio/mpeg' });
    if (error) throw error;
    uploadedPaths.push(objectPath);
    return objectPath;
  };

  const inBucket = async (objectPath) => {
    const { data, error } = await admin.storage
      .from(CARD_AUDIO_BUCKET)
      .list('', { limit: 100, search: objectPath });
    if (error) throw error;
    return data.some((object) => object.name === objectPath);
  };

  const createDeck = async (name) => {
    const { data, error } = await admin
      .from('decks')
      .insert({ user_id: userId, name: `${prefix} ${name}`, known_language: 'en', learning_language: 'ko' })
      .select()
      .single();
    if (error) throw error;
    createdDeckIds.push(data.id);
    return data.id;
  };

  let position = 0;
  const createCard = async (deckId, frontAudio, backAudio) => {
    const { data, error } = await admin
      .from('cards')
      .insert({
        deck_id: deckId,
        position: ++position,
        front_text: 'front',
        back_text: 'back',
        front_lang: 'en',
        back_lang: 'ko',
        front_audio_path: frontAudio,
        back_audio_path: backAudio
      })
      .select()
      .single();
    if (error) throw error;
    return data.id;
  };

  const cardExists = async (cardId) => {
    const { data, error } = await admin.from('cards').select('id').eq('id', cardId).maybeSingle();
    if (error) throw error;
    return Boolean(data);
  };

  beforeAll(async () => {
    admin = createClient(localEnv.API_URL, localEnv.SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.listUsers();
    if (error) throw error;
    const user = data.users.find((candidate) => candidate.email === TEST_EMAIL);
    if (!user) throw new Error(`Seed the local stack first: no ${TEST_EMAIL}`);
    userId = user.id;
  });

  afterAll(async () => {
    if (!admin) return;
    if (createdDeckIds.length) await admin.from('decks').delete().in('id', createdDeckIds);
    if (uploadedPaths.length) await admin.storage.from(CARD_AUDIO_BUCKET).remove(uploadedPaths);
  });

  it('uploads through the service role leave owner null, so a client cannot delete them', async () => {
    const objectPath = await upload('owner_probe');
    const user = createClient(localEnv.API_URL, localEnv.ANON_KEY, { auth: { persistSession: false } });
    const { error: signInError } = await user.auth.signInWithPassword({ email: TEST_EMAIL, password: 'password' });
    expect(signInError).toBeNull();

    const { data, error } = await user.storage.from(CARD_AUDIO_BUCKET).remove([objectPath]);

    // The bucket's delete policy is `auth.uid() = owner`, so this matches
    // nothing - and reports success anyway.
    expect(error).toBeNull();
    expect(data).toEqual([]);
    await expect(inBucket(objectPath)).resolves.toBe(true);
  });

  it('keeps audio a translation-pair sibling still references', async () => {
    const deckId = await createDeck('pair');
    const [front, back] = [await upload('pair_front'), await upload('pair_back')];
    // The crosswise pair CardModal builds: same two objects, swapped sides.
    const cardA = await createCard(deckId, front, back);
    const cardB = await createCard(deckId, back, front);

    const result = await deleteCardsAndAudio(admin, { userId, cardIds: [cardA] });

    expect(result.deletedAudio).toEqual([]);
    expect(result.missingAudio).toEqual([]);
    await expect(cardExists(cardA)).resolves.toBe(false);
    await expect(cardExists(cardB)).resolves.toBe(true);
    await expect(inBucket(front)).resolves.toBe(true);
    await expect(inBucket(back)).resolves.toBe(true);

    // Deleting the last card of the pair releases both objects.
    const second = await deleteCardsAndAudio(admin, { userId, cardIds: [cardB] });

    expect(second.deletedAudio.sort()).toEqual([back, front].sort());
    expect(second.missingAudio).toEqual([]);
    await expect(inBucket(front)).resolves.toBe(false);
    await expect(inBucket(back)).resolves.toBe(false);
  });

  it('deletes audio only this card references', async () => {
    const deckId = await createDeck('solo');
    const only = await upload('solo_front');
    const cardId = await createCard(deckId, only, null);

    const result = await deleteCardsAndAudio(admin, { userId, cardIds: [cardId] });

    expect(result.deletedAudio).toEqual([only]);
    await expect(inBucket(only)).resolves.toBe(false);
  });

  it('deleting a deck releases its pairs but keeps audio another deck still uses', async () => {
    const deckId = await createDeck('deck_pair');
    const otherDeckId = await createDeck('deck_other');
    const front = await upload('deck_front');
    const back = await upload('deck_back');
    const shared = await upload('deck_shared');

    await createCard(deckId, front, back);
    await createCard(deckId, back, front);
    await createCard(deckId, shared, null);
    // A card outside the deck being deleted, pointing at one of its objects.
    await createCard(otherDeckId, shared, null);

    const result = await deleteCardsAndAudio(admin, { userId, deckId });

    expect(result.deletedAudio.sort()).toEqual([back, front].sort());
    await expect(inBucket(front)).resolves.toBe(false);
    await expect(inBucket(back)).resolves.toBe(false);
    await expect(inBucket(shared)).resolves.toBe(true);

    const { data: deck } = await admin.from('decks').select('id').eq('id', deckId).maybeSingle();
    expect(deck).toBeNull();
    const { data: leftovers } = await admin.from('cards').select('id').eq('deck_id', deckId);
    expect(leftovers).toEqual([]);
  });

  it('refuses to delete another user\'s card or touch its audio', async () => {
    const deckId = await createDeck('owned');
    const only = await upload('owned_front');
    const cardId = await createCard(deckId, only, null);

    const result = await deleteCardsAndAudio(admin, {
      userId: '00000000-0000-0000-0000-000000000000',
      cardIds: [cardId]
    });

    expect(result.deletedAudio).toEqual([]);
    await expect(cardExists(cardId)).resolves.toBe(true);
    await expect(inBucket(only)).resolves.toBe(true);
  });

  it('rejects a request that names both a deck and cards', async () => {
    await expect(deleteCardsAndAudio(admin, { userId, deckId: 'x', cardIds: ['y'] }))
      .rejects.toThrow(/not both/);
  });
});
