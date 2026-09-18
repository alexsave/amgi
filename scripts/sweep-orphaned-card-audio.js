#!/usr/bin/env node
//
// One-off sweep for the `card-audio` objects orphaned before deletion started
// cleaning up after itself (every deck ever deleted left its cards' mp3s in a
// publicly readable bucket).
//
// Dry run by default - it prints what it would remove and nothing else:
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/sweep-orphaned-card-audio.js
//
// To actually delete, both flags are required, and the confirmation has to
// name the host you are pointing at, so an --apply left in a shell history
// cannot fire at the wrong project:
//
//   SWEEP_CONFIRM=<host of SUPABASE_URL> node scripts/sweep-orphaned-card-audio.js --apply
//
// An object is orphaned when no `cards` row has it as front_audio_path or
// back_audio_path. Objects younger than GRACE_HOURS are always left alone:
// the cards edge function uploads audio before the card row exists, so a card
// a user is still editing in the modal looks orphaned but is not.
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'card-audio';
const PAGE = 1000;
const REMOVE_BATCH = 100;
const GRACE_HOURS = Number(process.env.GRACE_HOURS || 24);

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const apply = process.argv.includes('--apply');

if (!url || !serviceRoleKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const host = new URL(url).host;
if (apply && process.env.SWEEP_CONFIRM !== host) {
  console.error(`Refusing to delete from ${host}: re-run with SWEEP_CONFIRM=${host}`);
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const listAllObjects = async () => {
  const objects = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await admin.storage.from(BUCKET).list('', { limit: PAGE, offset });
    if (error) throw error;
    objects.push(...data);
    if (data.length < PAGE) return objects;
  }
};

const listReferencedPaths = async () => {
  const referenced = new Set();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('cards')
      .select('front_audio_path, back_audio_path')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const card of data) {
      if (card.front_audio_path) referenced.add(card.front_audio_path);
      if (card.back_audio_path) referenced.add(card.back_audio_path);
    }
    if (data.length < PAGE) return referenced;
  }
};

(async () => {
  console.log(`Sweeping ${BUCKET} on ${host} (${apply ? 'APPLY' : 'dry run'})`);

  const [objects, referenced] = await Promise.all([listAllObjects(), listReferencedPaths()]);
  const cutoff = Date.now() - GRACE_HOURS * 60 * 60 * 1000;

  const orphans = objects.filter((object) => !referenced.has(object.name));
  const tooYoung = orphans.filter((object) => new Date(object.created_at).getTime() > cutoff);
  const removable = orphans.filter((object) => new Date(object.created_at).getTime() <= cutoff);
  const bytes = removable.reduce((total, object) => total + (object.metadata?.size || 0), 0);

  console.log(`  objects in bucket:     ${objects.length}`);
  console.log(`  referenced by a card:  ${referenced.size}`);
  console.log(`  orphaned:              ${orphans.length}`);
  console.log(`  ${`within ${GRACE_HOURS}h grace:`.padEnd(21)}  ${tooYoung.length} (kept)`);
  console.log(`  removable:             ${removable.length} (${(bytes / 1024 / 1024).toFixed(1)} MiB)`);

  if (!apply) {
    for (const object of removable.slice(0, 20)) console.log(`    would remove ${object.name}`);
    if (removable.length > 20) console.log(`    ... and ${removable.length - 20} more`);
    console.log('\nDry run: nothing was deleted. Re-run with --apply to delete.');
    return;
  }

  let removed = 0;
  for (let i = 0; i < removable.length; i += REMOVE_BATCH) {
    const batch = removable.slice(i, i + REMOVE_BATCH).map((object) => object.name);
    const { data, error } = await admin.storage.from(BUCKET).remove(batch);
    if (error) throw error;
    removed += (data || []).length;
    console.log(`  removed ${removed}/${removable.length}`);
  }
  console.log(`Done: ${removed} objects removed.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
