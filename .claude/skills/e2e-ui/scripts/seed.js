// Seeds the LOCAL Supabase stack with the test account the welcome page's
// "Try Test Account" button signs in as, plus a deck whose cards have real
// audio (macOS `say`), so review can be driven end to end offline.
//
//   node .claude/skills/e2e-ui/scripts/seed.js
//
// Idempotent: if the user already owns decks, it leaves them alone.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

const envFile = process.env.SUPA_ENV || path.join(process.cwd(), '.e2e', 'local-supa.env');
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/);
  if (m) env[m[1]] = m[2];
}

const URL = env.API_URL;
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;
const EMAIL = 'test@amgi.cards';
const PW = 'password';

if (!URL || !URL.includes('127.0.0.1')) {
  throw new Error(`Refusing to seed a non-local Supabase: ${URL}`);
}

const PAIRS = [
  ['Hello', '안녕하세요'],
  ['Thank you', '감사합니다'],
  ['Where is the bathroom?', '화장실이 어디예요?'],
  ['How much is this?', '이거 얼마예요?'],
  ["I'm hungry", '배고파요'],
];

function tts(text, voice) {
  const out = path.join(os.tmpdir(), `amgi-seed-${Math.random().toString(36).slice(2)}.wav`);
  execFileSync('say', ['-v', voice, '-o', out, '--file-format=WAVE', '--data-format=LEI16@22050', text]);
  return fs.readFileSync(out);
}

(async () => {
  const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });
  const { data: list } = await admin.auth.admin.listUsers();
  let user = list.users.find((u) => u.email === EMAIL);
  if (!user) {
    // email_confirm skips the local confirmation mail entirely.
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PW,
      email_confirm: true,
    });
    if (error) throw error;
    user = data.user;
    console.log('created user', user.id);
  } else {
    console.log('user exists', user.id);
  }

  // Everything below goes through the anon client as the user would, so RLS
  // is exercised rather than bypassed.
  const client = createClient(URL, ANON);
  const { data: session, error: signInErr } = await client.auth.signInWithPassword({
    email: EMAIL,
    password: PW,
  });
  if (signInErr) throw signInErr;
  const uid = session.user.id;

  const { data: existingDecks } = await client.from('decks').select('*');
  if (existingDecks?.length) {
    console.log('decks already seeded:', existingDecks.map((d) => d.name).join(', '));
    return;
  }

  const { data: deck, error: deckErr } = await client
    .from('decks')
    .insert({ user_id: uid, name: 'Korean Phrases', known_language: 'en', learning_language: 'ko' })
    .select()
    .single();
  if (deckErr) throw deckErr;

  let pos = 1;
  for (const [en, ko] of PAIRS) {
    // Both directions, the way the app creates a translation pair.
    const directions = [
      [en, ko, 'en', 'ko', 'Samantha', 'Yuna'],
      [ko, en, 'ko', 'en', 'Yuna', 'Samantha'],
    ];
    for (const [front, back, frontLang, backLang, frontVoice, backVoice] of directions) {
      const fPath = `${Date.now()}_front_${Math.random().toString(36).slice(2, 10)}.wav`;
      const bPath = `${Date.now()}_back_${Math.random().toString(36).slice(2, 10)}.wav`;
      for (const [p, text, voice] of [[fPath, front, frontVoice], [bPath, back, backVoice]]) {
        const { error } = await client.storage
          .from('card-audio')
          .upload(p, tts(text, voice), { contentType: 'audio/wav' });
        if (error) throw error;
      }
      const { data: card, error: cardErr } = await client
        .from('cards')
        .insert({
          deck_id: deck.id,
          position: pos++,
          front_text: front,
          back_text: back,
          front_lang: frontLang,
          back_lang: backLang,
          front_audio_path: fPath,
          back_audio_path: bPath,
        })
        .select()
        .single();
      if (cardErr) throw cardErr;

      const { error: revErr } = await client.from('reviews').insert({
        card_id: card.id,
        user_id: uid,
        scheduled_date: new Date().toISOString().slice(0, 10),
        interval_days: 1,
        ease_factor: 2.5,
        repetitions: 0,
        card_state: 'new',
      });
      if (revErr) throw revErr;
    }
  }
  console.log(`seeded ${pos - 1} cards with audio in deck ${deck.id}`);
})();
