'use strict';

// Covers the reading-system policy in cardText.ts: readings for opaque
// scripts must be given in the learner's own script, never romanised. The
// owner's rule, restated in cardText.ts: if you're learning a language, you
// use that language to read it.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { readingSystem, readingIsAmbiguous } = require('../lib/cardGeneration/cardText.ts');
const { buildCardGenerationPrompt } = require('../lib/cardGeneration/cardPrompts.ts');

test('readingSystem names a native script for every opaque-reading language, never a romanisation', () => {
  // The old systems named a romanisation outright: Hepburn romaji, Hanyu
  // Pinyin, Jyutping. None of those names should appear as the SYSTEM NAMED
  // any more - "never romaji" as a negation inside the new instruction is
  // fine and expected, so this checks for the old systems by name instead of
  // for the substring "romaji".
  assert.match(readingSystem('ja'), /hiragana/i);
  assert.doesNotMatch(readingSystem('ja'), /hepburn/i);

  assert.match(readingSystem('zh_cn'), /zhuyin|bopomofo|注音/i);
  assert.doesNotMatch(readingSystem('zh_cn'), /hanyu pinyin/i);

  assert.match(readingSystem('zh_hk'), /bopomofo|注音/i);
  // "never Jyutping or Yale" (a negation) is fine; being TOLD to use one as
  // the system is not - so this checks the system does not start with one.
  assert.doesNotMatch(readingSystem('zh_hk'), /^(jyutping|yale)/i);
});

test('readingSystem is null for languages whose spelling already fixes the reading', () => {
  assert.equal(readingSystem('ko'), null);
  assert.equal(readingSystem('en'), null);
});

test('readingIsAmbiguous still names exactly the languages that have a reading system', () => {
  for (const lang of ['ja', 'zh_cn', 'zh_hk']) {
    assert.ok(readingIsAmbiguous(lang), `${lang} should be reading-ambiguous`);
    assert.ok(readingSystem(lang), `${lang} should have a reading system`);
  }
});

test('the generation prompt tells the model to write the reading in its own script, not romanised', () => {
  const prompt = buildCardGenerationPrompt({
    userInput: 'thank you',
    knownLanguage: 'en',
    learningLanguage: 'ja',
  });

  assert.match(prompt, /hiragana/i);
  assert.doesNotMatch(prompt, /hepburn|Latin alphabet/i);
});
