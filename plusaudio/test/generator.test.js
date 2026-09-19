'use strict';

// The CLI's half of the shared generator.
//
// What is worth testing HERE is that plain Node can load that TypeScript
// module at all - no jest, no bundler, no build step - and that what comes
// back out of it is a Buffer of the right bytes, because that is the contract
// augmentPackage relies on. The policy's own logic (prompts, retries, the
// audio judge) is exercised through this same seam - there is no separate
// edge-function runtime to test it from any more; see
// ../lib/cardGeneration/cardGeneration.ts for where it lives now and why.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { createGenerator } = require('../lib/generator');
const { CARD_MODELS } = require('../lib/cardGeneration/models.ts');

function scriptedClient({ transcript, clip }) {
  const calls = { speech: [], transcription: [], chat: [] };
  return {
    calls,
    chat: {
      completions: {
        create: async (body) => {
          calls.chat.push(body);
          throw new Error('no chat response scripted');
        },
      },
    },
    audio: {
      speech: {
        create: async (body) => {
          calls.speech.push(body);
          return { arrayBuffer: async () => clip.buffer.slice(clip.byteOffset, clip.byteOffset + clip.length) };
        },
      },
      transcriptions: {
        create: async (body) => {
          calls.transcription.push(body);
          return { text: transcript };
        },
      },
    },
  };
}

test('generates a clip through the shared policy and hands back a Buffer', async () => {
  const clip = Uint8Array.from([0xff, 0xfb, 0x90, 0x00]);
  const openai = scriptedClient({ transcript: '배고파요?', clip });

  const generate = createGenerator(openai);
  const audio = await generate({ text: '배고파요?', language: 'ko' });

  assert.ok(Buffer.isBuffer(audio));
  assert.deepEqual([...audio], [...clip]);

  // The models and the speaking instructions are the app's, not a second set.
  assert.equal(openai.calls.speech[0].model, CARD_MODELS.tts);
  assert.equal(openai.calls.transcription[0].model, CARD_MODELS.transcribe);
  assert.equal(openai.calls.speech[0].input, '배고파요?');
  assert.match(openai.calls.speech[0].instructions, /한국어 원어민처럼/);
});

test('refuses a clip that does not say what the note says', async () => {
  const openai = scriptedClient({ transcript: 'something else entirely', clip: Uint8Array.from([1]) });
  const lines = [];
  const generate = createGenerator(openai, { log: (line) => lines.push(line) });

  // The audio judge is unreachable in this stub, and so is the transcript
  // judge behind it, so every attempt fails and nothing is returned.
  await assert.rejects(
    generate({ text: '배고파요?', language: 'ko' }),
    /Failed to generate valid audio for "배고파요\?" after 3 attempts/,
  );
  assert.equal(openai.calls.speech.length, 3);
  assert.ok(lines.some((line) => line.includes('Audio judge failed')));
});
