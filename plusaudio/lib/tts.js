'use strict';

// The generator: synthesise a clip and refuse to keep one that does not say
// what the card says.
//
// Lifted, with the dead ends removed, from the 2025 index.js loop: generate
// with gpt-4o-audio-preview, transcribe the result blind, require an exact
// match after normalisation, and fall back to a judge for the cases where
// Korean sound-change rules make a correct reading spell differently. Voices
// rotate so a voice that cannot say a word does not block it.
//
// This is deliberately the smallest thing that works. The card generation
// policy in supabase/functions/_shared/ is the better generator and is being
// lifted into a shared module separately; when it lands, this file becomes a
// thin adapter to it.

const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const MAX_CLIP_BYTES = 50_000;

const TRANSCRIBE_TOOL = {
  type: 'function',
  function: {
    name: 'transcribe_audio',
    description: 'Report exactly what is said in the audio.',
    parameters: {
      type: 'object',
      properties: { transcription: { type: 'string' } },
      required: ['transcription'],
    },
  },
};

function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{Script=Hangul}\p{Letter}\p{Number}]/gu, '')
    .trim();
}

async function synthesise(openai, text, voice) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-audio-preview',
    modalities: ['text', 'audio'],
    audio: { voice, format: 'mp3' },
    messages: [
      {
        role: 'system',
        content:
          'You are a native speaker. Pronounce ONLY the text provided. Say it once clearly and ' +
          'naturally, then stop. Do not repeat it, do not explain it, do not say anything else.',
      },
      { role: 'user', content: `Say this once: ${text}` },
    ],
  });
  const data = response.choices[0].message.audio?.data;
  if (!data) throw new Error('no audio in response');
  return Buffer.from(data, 'base64');
}

async function transcribe(openai, audio) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-audio-preview',
    messages: [
      {
        role: 'system',
        content:
          'Transcribe exactly what you hear. Do not guess at what it was supposed to say.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Transcribe this audio.' },
          { type: 'input_audio', input_audio: { data: audio.toString('base64'), format: 'mp3' } },
        ],
      },
    ],
    tools: [TRANSCRIBE_TOOL],
    tool_choice: { type: 'function', function: { name: 'transcribe_audio' } },
  });
  const call = response.choices[0].message.tool_calls?.[0];
  if (!call) return '';
  return JSON.parse(call.function.arguments).transcription ?? '';
}

// Hangul is phonemic, so a mis-read is a different spelling - except where a
// sound-change rule makes a correct reading transcribe differently. That case,
// and only that case, is worth a second opinion.
async function soundsTheSame(openai, expected, heard, language) {
  if (language !== 'ko') return false;
  const response = await openai.chat.completions.create({
    model: 'o4-mini-2025-04-16',
    messages: [
      {
        role: 'user',
        content:
          'Under standard Korean pronunciation rules (assimilation, tensification, liaison, ' +
          `palatalisation), are "${expected}" and "${heard}" pronounced identically? ` +
          'Answer with the single word YES or NO.',
      },
    ],
  });
  return /\byes\b/i.test(response.choices[0].message.content ?? '');
}

/**
 * Build a generator for augmentPackage.
 *
 * @param {object} openai      an OpenAI client
 * @param {object} [options]
 * @param {number} [options.maxVoices]
 * @param {number} [options.attemptsPerVoice]
 * @param {function} [options.log]
 */
function createGenerator(openai, options = {}) {
  const { maxVoices = 5, attemptsPerVoice = 2, log = () => {} } = options;

  return async function generate({ text, language }) {
    const expected = normalise(text);
    const voices = [...VOICES].sort(() => Math.random() - 0.5).slice(0, maxVoices);

    for (const voice of voices) {
      for (let attempt = 0; attempt < attemptsPerVoice; attempt += 1) {
        let audio;
        try {
          audio = await synthesise(openai, text, voice);
        } catch (error) {
          log(`  ${voice}: synthesis failed (${error.message})`);
          continue;
        }
        if (audio.length > MAX_CLIP_BYTES) {
          log(`  ${voice}: ${audio.length} bytes is too long for one utterance`);
          continue;
        }
        const heard = await transcribe(openai, audio);
        if (normalise(heard) === expected) return audio;
        if (await soundsTheSame(openai, text, heard, language)) return audio;
        log(`  ${voice}: heard "${heard}", expected "${text}"`);
      }
    }
    throw new Error(`no voice produced a clip that reads back as "${text}"`);
  };
}

module.exports = { createGenerator, normalise, VOICES };
