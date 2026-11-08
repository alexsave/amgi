#!/usr/bin/env node
'use strict';

// Run the pipeline twice over a real deck with audio generation stubbed, and
// print the identity numbers. Pair with tools/verify-with-anki.py, which checks
// the same outputs against Anki's own importer.
//
//   node tools/verify-runs.js <deck.apkg> <output-dir> [--audio-tag sound|html]
//
// Writes run1.apkg (from the input), run2.apkg (from the input again) and
// run3.apkg (from run1's own output), then switch1.apkg (run1 re-run in the
// other reference form) and switch2.apkg (switch1 re-run in that same form),
// which is what proves a deck converts rather than accumulating references.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { augmentPackage } = require('../lib/augment');
const { isOwnedMediaName } = require('../lib/audio-store');
const { audioReferences } = require('../lib/deck');
const { openPackage } = require('../lib/package');
const { readZip } = require('../lib/zip');

// The twelve bytes a WAV file starts with (RIFF, a size, WAVE) - every clip
// amgi generates now is WAV (see lib/cardGeneration/geminiSpeech.ts).
const WAV_HEADER = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVE')]);

// A deterministic, valid-enough stand-in for a generated clip: no API key, no
// network, and identical text always produces identical bytes.
async function stubGenerate({ text }) {
  const noise = crypto.createHash('sha256').update(text).digest();
  return Buffer.concat([WAV_HEADER, noise]);
}

function digest(rows) {
  const canonical = rows.map((row) =>
    Object.keys(row)
      .sort()
      .map((key) => `${key}=${row[key]}`)
      .join('|'),
  );
  return crypto.createHash('sha256').update(canonical.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Deck ids and names, whichever schema the collection is in: 11 keeps them in
 * a JSON blob in `col`, 18 in a table of its own.
 */
function deckNames(pkg) {
  if (pkg.schemaVersion === 11) {
    const blob = JSON.parse(pkg.db.prepare('SELECT decks FROM col').get().decks);
    return Object.values(blob)
      .map((deck) => `${deck.id}:${deck.name}`)
      .sort()
      .join('\n');
  }
  return pkg.metadataDb
    .prepare('SELECT id, name FROM decks')
    .all()
    .map((deck) => `${deck.id}:${deck.name}`)
    .sort()
    .join('\n');
}

/** Every member except the two this tool sets out to rewrite. */
function passthroughMembers(filePath) {
  const pkg = openPackage(filePath);
  const rewritten = new Set([pkg.collectionName, 'media']);
  pkg.close();
  const members = new Map();
  for (const entry of readZip(filePath)) {
    if (!rewritten.has(entry.name)) members.set(entry.name, entry.data());
  }
  return members;
}

function snapshot(filePath) {
  const pkg = openPackage(filePath);
  try {
    const notes = pkg.db.prepare('SELECT id, guid, mid, mod, flds FROM notes ORDER BY id').all();
    // Scanned across the whole note rather than one field: a generated clip is
    // ours wherever it turns up, and counting them all is what catches a
    // conversion that left the old reference behind.
    const owned = notes.map((note) =>
      audioReferences(note.flds).filter((reference) => isOwnedMediaName(reference.name)),
    );
    const cards = pkg.db.prepare('SELECT * FROM cards ORDER BY id').all();
    const revlog = pkg.db.prepare('SELECT * FROM revlog ORDER BY id').all();
    return {
      path: filePath,
      format: pkg.format,
      notes,
      noteIds: notes.map((n) => String(n.id)),
      guids: notes.map((n) => n.guid),
      cardIds: cards.map((c) => String(c.id)),
      owned,
      ownedTotal: owned.reduce((sum, list) => sum + list.length, 0),
      ownedForms: [...new Set(owned.flat().map((reference) => reference.form))].sort(),
      notesWithTwoReferences: owned.filter((list) => list.length > 1).length,
      revlogCount: revlog.length,
      revlogDigest: digest(revlog),
      cardsDigest: digest(cards),
      schemaVersion: pkg.schemaVersion,
      decks: deckNames(pkg),
      media: Object.keys(pkg.mediaMap).length,
    };
  } finally {
    pkg.close();
  }
}

function sameSet(a, b) {
  return a.length === b.length && new Set(a).size === new Set(b).size && a.every((v, i) => v === b[i]);
}

function report(label, snap) {
  console.log(
    `${label.padEnd(8)} format=${snap.format} schema=${snap.schemaVersion} notes=${snap.notes.length} ` +
      `distinct-guids=${new Set(snap.guids).size} cards=${snap.cardIds.length} ` +
      `revlog=${snap.revlogCount} revlog-sha=${snap.revlogDigest} ` +
      `cards-sha=${snap.cardsDigest} media=${snap.media} ` +
      `clips=${snap.ownedTotal} form=${snap.ownedForms.join('+') || 'none'}`,
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const tagIndex = argv.indexOf('--audio-tag');
  const audioTag = tagIndex === -1 ? 'sound' : argv[tagIndex + 1];
  const positional = tagIndex === -1 ? argv : [...argv.slice(0, tagIndex), ...argv.slice(tagIndex + 2)];
  const [input, outDir] = positional;
  if (!input || !outDir || !['sound', 'html'].includes(audioTag)) {
    process.stderr.write('usage: node tools/verify-runs.js <deck.apkg> <output-dir> [--audio-tag sound|html]\n');
    return 1;
  }
  const otherTag = audioTag === 'sound' ? 'html' : 'sound';
  fs.mkdirSync(outDir, { recursive: true });
  const cacheDir = path.join(outDir, 'cache');

  const run1 = path.join(outDir, 'run1.apkg');
  const run2 = path.join(outDir, 'run2.apkg');
  const run3 = path.join(outDir, 'run3.apkg');
  const switch1 = path.join(outDir, 'switch1.apkg');
  const switch2 = path.join(outDir, 'switch2.apkg');

  // A conversion happens after the first generation, and Anki only applies an
  // incoming note whose `mod` is newer than the collection's copy. Stamping the
  // switch runs a minute later is what a real second run would do, and without
  // it Anki reports the converted notes as duplicates and keeps the old form.
  const now = Math.floor(Date.now() / 1000);
  const laterOn = now + 60;

  const augment = (inputPath, outputPath, tag) =>
    augmentPackage({ inputPath, outputPath, generate: stubGenerate, cacheDir, audioTag: tag, now });

  console.log(`audio tag: ${audioTag} (switching to ${otherTag} for the last two runs)`);
  console.log('');

  const s1 = await augment(input, run1, audioTag);
  const s2 = await augment(input, run2, audioTag);
  const s3 = await augment(run1, run3, audioTag);

  // No cache directory for the switch, so a conversion that wanted a clip it
  // did not already have would have to call the generator and be caught.
  let switchGenerations = 0;
  const countingGenerate = async (request) => {
    switchGenerations += 1;
    return stubGenerate(request);
  };
  const s4 = await augmentPackage({
    inputPath: run1,
    outputPath: switch1,
    generate: countingGenerate,
    audioTag: otherTag,
    now: laterOn,
  });
  const s5 = await augmentPackage({
    inputPath: switch1,
    outputPath: switch2,
    generate: countingGenerate,
    audioTag: otherTag,
    now: laterOn,
  });

  console.log(`run 1   (${audioTag}, from input): `, JSON.stringify({ ...s1, skipped: s1.skipped.length }));
  console.log(`run 2   (${audioTag}, from input): `, JSON.stringify({ ...s2, skipped: s2.skipped.length }));
  console.log(`run 3   (${audioTag}, from run 1):`, JSON.stringify({ ...s3, skipped: s3.skipped.length }));
  console.log(`switch1 (${otherTag}, from run 1):`, JSON.stringify({ ...s4, skipped: s4.skipped.length }));
  console.log(`switch2 (${otherTag}, from sw 1):`, JSON.stringify({ ...s5, skipped: s5.skipped.length }));
  console.log('');

  const input_ = snapshot(input);
  const out1 = snapshot(run1);
  const out2 = snapshot(run2);
  const out3 = snapshot(run3);
  const sw1 = snapshot(switch1);
  const sw2 = snapshot(switch2);
  report('input', input_);
  report('run1', out1);
  report('run2', out2);
  report('run3', out3);
  report('switch1', sw1);
  report('switch2', sw2);
  console.log('');

  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail });

  for (const [label, snap] of [
    ['run1', out1],
    ['run2', out2],
    ['run3', out3],
    ['switch1', sw1],
    ['switch2', sw2],
  ]) {
    add(`${label}: note guids identical to input`, sameSet(snap.guids, input_.guids));
    add(`${label}: note ids identical to input`, sameSet(snap.noteIds, input_.noteIds));
    add(`${label}: card ids identical to input`, sameSet(snap.cardIds, input_.cardIds));
    add(
      `${label}: revlog unchanged`,
      snap.revlogCount === input_.revlogCount && snap.revlogDigest === input_.revlogDigest,
      `${snap.revlogCount} rows, ${snap.revlogDigest}`,
    );
    add(`${label}: cards and scheduling unchanged`, snap.cardsDigest === input_.cardsDigest);
    add(`${label}: deck names and ids unchanged`, snap.decks === input_.decks);
    add(
      `${label}: written back in the layout it was read in`,
      snap.format === input_.format && snap.schemaVersion === input_.schemaVersion,
      `${snap.format}/${snap.schemaVersion} from ${input_.format}/${input_.schemaVersion}`,
    );
    add(
      `${label}: no note points at the same clip twice`,
      snap.notesWithTwoReferences === 0,
      `${snap.notesWithTwoReferences} notes with more than one generated reference`,
    );
  }

  const modBumped = out1.notes.filter((n, i) => n.mod !== input_.notes[i].mod).length;
  const fldsChanged = out1.notes.filter((n, i) => n.flds !== input_.notes[i].flds).length;
  add('run1: mod bumped exactly on the notes whose fields changed', modBumped === fldsChanged,
    `${modBumped} bumped, ${fldsChanged} changed`);

  // Everything but the collection and the media map has to come out of the zip
  // exactly as it went in, compressed bytes and all.
  const sourceMembers = passthroughMembers(input);
  const run1Members = passthroughMembers(run1);
  const changed = [...sourceMembers].filter(
    ([name, data]) => !run1Members.has(name) || !run1Members.get(name).equals(data),
  );
  add('run1: every passthrough member survives byte for byte', changed.length === 0,
    `${sourceMembers.size} members, ${changed.length} changed`);
  add('run1: the media it added is new members, not renumbered ones',
    run1Members.size === sourceMembers.size + s1.mediaAdded,
    `${sourceMembers.size} in, ${run1Members.size} out, ${s1.mediaAdded} added`);

  const run3Unchanged = out3.notes.every((n, i) => n.mod === out1.notes[i].mod && n.flds === out1.notes[i].flds);
  add('run3: re-running on the output changes no note at all', run3Unchanged);
  add('run3: byte-identical to run1', fs.readFileSync(run3).equals(fs.readFileSync(run1)));
  add('run2: generated nothing (served from the clip cache)', s2.audioGenerated === 0);
  add('run3: generated nothing', s3.audioGenerated === 0);
  add(`run1: every generated reference is written as ${audioTag}`,
    out1.ownedForms.length === 1 && out1.ownedForms[0] === audioTag, out1.ownedForms.join('+'));

  add(`switch1: converting to ${otherTag} regenerated no audio`, switchGenerations === 0 && s4.audioGenerated === 0,
    `${switchGenerations} generator calls`);
  add('switch1: the package carries exactly the media run1 carried', sw1.media === out1.media,
    `${sw1.media} vs ${out1.media}`);
  add('switch1: the same clips are referenced, just written differently',
    sw1.ownedTotal === out1.ownedTotal &&
      JSON.stringify(sw1.owned.map((list) => list.map((r) => r.name))) ===
        JSON.stringify(out1.owned.map((list) => list.map((r) => r.name))),
    `${sw1.ownedTotal} references`);
  add(`switch1: every generated reference is now written as ${otherTag}`,
    sw1.ownedForms.length === 1 && sw1.ownedForms[0] === otherTag, sw1.ownedForms.join('+'));
  add('switch2: re-running in the new form changes no note at all',
    sw2.notes.every((n, i) => n.mod === sw1.notes[i].mod && n.flds === sw1.notes[i].flds));
  add('switch2: byte-identical to switch1', fs.readFileSync(switch2).equals(fs.readFileSync(switch1)));
  add('switch1: the converted notes are stamped newer, so Anki applies them',
    sw1.notes.every((n, i) => n.flds === out1.notes[i].flds || n.mod > out1.notes[i].mod));

  let failures = 0;
  for (const check of checks) {
    if (!check.ok) failures += 1;
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? `  (${check.detail})` : ''}`);
  }
  console.log('');
  console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
  },
);
