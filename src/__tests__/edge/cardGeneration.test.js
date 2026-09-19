/**
 * The card generator: the calls it makes, the text it assembles, and the audio
 * it refuses.
 *
 * This is the policy the `cards` edge function (Deno) and the plusaudio CLI
 * (Node) both run, so it is tested where the rest of the suite lives, with the
 * OpenAI client replaced by a script of canned responses. No key, no network:
 * the client is an injected seam precisely so that is possible.
 *
 * The module was lifted out of supabase/functions/cards/index.ts, which is
 * live, so most of what is pinned here is pinned because changing it would
 * change a card someone already has.
 */
const {
  GENERATED_CARD_FORMAT,
  KNOWN_SIDE_FORMAT,
  LEARNING_SIDE_FORMAT,
  cardTextMode,
  generateCardAudio,
  generateCardText,
  getTtsInstructions,
} = require('../../../supabase/functions/_shared/cardGeneration.ts');

const {
  CARD_GENERATION_SYSTEM_PROMPT,
  CARD_REGENERATION_SYSTEM_PROMPT,
  buildBothSidesRegenerationPrompt,
  buildCardGenerationPrompt,
  buildKnownSideRegenerationPrompt,
  buildLearningSideRegenerationPrompt,
  buildUnspeakableRetryPrompt,
} = require('../../../supabase/functions/_shared/cardPrompts.ts');

const { CARD_MODELS } = require('../../../supabase/functions/_shared/models.ts');

// ========================
// A SCRIPTED OPENAI CLIENT
// ========================

/**
 * @param {object} script  queues of canned responses per endpoint. A queued
 *   Error is thrown instead of returned, which is how an outage is staged.
 */
function scriptedClient({ chat = [], speech = [], transcription = [] } = {}) {
  const calls = { chat: [], speech: [], transcription: [] };

  const take = (queue, kind) => {
    if (queue.length === 0) throw new Error(`no scripted ${kind} response left`);
    const item = queue.shift();
    if (item instanceof Error) throw item;
    return item;
  };

  let clipCounter = 0;

  return {
    calls,
    chat: {
      completions: {
        create: async (body) => {
          calls.chat.push(body);
          return take(chat, 'chat');
        },
      },
    },
    audio: {
      speech: {
        create: async (body) => {
          calls.speech.push(body);
          if (speech.length > 0) return take(speech, 'speech');
          // A distinct clip per attempt, so a test can tell which one was kept.
          clipCounter += 1;
          const bytes = new Uint8Array([clipCounter]);
          return { arrayBuffer: async () => bytes.buffer };
        },
      },
      transcriptions: {
        create: async (body) => {
          calls.transcription.push(body);
          return take(transcription, 'transcription');
        },
      },
    },
  };
}

const jsonMessage = (payload) => ({ choices: [{ message: { content: JSON.stringify(payload) } }] });

const judgement = (verdict) => ({
  choices: [{
    message: {
      tool_calls: [{
        type: 'function',
        function: { name: 'judge_audio', arguments: JSON.stringify(verdict) },
      }],
    },
  }],
});

const silentLog = { warn: () => {}, error: () => {} };

const contextFor = (openai, log = silentLog) => ({ openai, models: CARD_MODELS, log });

const clipByte = async (buffer) => new Uint8Array(buffer)[0];

// ========================
// SCHEMAS
// ========================

// Pinned against what `zodResponseFormat(schema, name)` produced from the zod
// schemas these replaced, key order included, because the object goes on the
// wire and the deployed function's requests must not change. Regenerate by
// running zodResponseFormat over the schemas in this file's git history if you
// ever need to prove it again.
describe('structured output formats', () => {
  test('the card schema is what zodResponseFormat produced', () => {
    expect(JSON.stringify(GENERATED_CARD_FORMAT)).toBe(JSON.stringify({
      type: 'json_schema',
      json_schema: {
        name: 'flashcard_generation',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            known_text: {
              type: 'string',
              description: 'The known-language side: one natural utterance, no annotation of any kind',
            },
            learning_text: {
              type: 'string',
              description: 'The learning-language side: one natural utterance in one sense, no annotation of any kind',
            },
            sense_tag: {
              type: 'string',
              description: "Usually empty. Fill it only when the input genuinely has a second, equally everyday meaning that a different card could teach - then two or three words in the learner's own language naming which of those meanings this card teaches, for example 'calendar day' for 'date'. Never a restatement, summary, topic or tone of the card itself.",
            },
            register: {
              type: 'string',
              enum: ['casual', 'polite', 'formal'],
              description: 'The politeness level the learning-language text actually uses',
            },
            spoken_reading: {
              type: 'string',
              description: 'How the learning-language text must be read aloud, romanised. Empty unless the writing system leaves the reading open (Japanese, Chinese).',
            },
          },
          required: ['known_text', 'learning_text', 'sense_tag', 'register', 'spoken_reading'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      },
    }));
  });

  test('the learning-side schema is what zodResponseFormat produced', () => {
    expect(JSON.stringify(LEARNING_SIDE_FORMAT)).toBe(JSON.stringify({
      type: 'json_schema',
      json_schema: {
        name: 'learning_side_regeneration',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            learning_text: {
              type: 'string',
              description: 'The rewritten learning-language side: one natural utterance in one sense, no annotation of any kind',
            },
            sense_tag: {
              type: 'string',
              description: "Usually empty. Fill it only when the input genuinely has a second, equally everyday meaning that a different card could teach - then two or three words in the learner's own language naming which of those meanings this card teaches, for example 'calendar day' for 'date'. Never a restatement, summary, topic or tone of the card itself.",
            },
            register: {
              type: 'string',
              enum: ['casual', 'polite', 'formal'],
              description: 'The politeness level the learning-language text actually uses',
            },
            spoken_reading: {
              type: 'string',
              description: 'How the learning-language text must be read aloud, romanised. Empty unless the writing system leaves the reading open (Japanese, Chinese).',
            },
          },
          required: ['learning_text', 'sense_tag', 'register', 'spoken_reading'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      },
    }));
  });

  test('the known-side schema is what zodResponseFormat produced, and asks for no reading', () => {
    expect(JSON.stringify(KNOWN_SIDE_FORMAT)).toBe(JSON.stringify({
      type: 'json_schema',
      json_schema: {
        name: 'known_side_regeneration',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            known_text: {
              type: 'string',
              description: 'The rewritten known-language side: one natural utterance, no annotation of any kind',
            },
            sense_tag: {
              type: 'string',
              description: "Usually empty. Fill it only when the input genuinely has a second, equally everyday meaning that a different card could teach - then two or three words in the learner's own language naming which of those meanings this card teaches, for example 'calendar day' for 'date'. Never a restatement, summary, topic or tone of the card itself.",
            },
            register: {
              type: 'string',
              enum: ['casual', 'polite', 'formal'],
              description: 'The politeness level the learning-language text actually uses',
            },
          },
          required: ['known_text', 'sense_tag', 'register'],
          additionalProperties: false,
          $schema: 'http://json-schema.org/draft-07/schema#',
        },
      },
    }));
  });
});

// ========================
// WHICH GENERATION IS ASKED FOR
// ========================

describe('cardTextMode', () => {
  test('no card and nothing named is a new card', () => {
    expect(cardTextMode([], false)).toBe('generate');
  });

  test('a rejected side names itself', () => {
    expect(cardTextMode(['front_text'], true)).toBe('known_side');
    expect(cardTextMode(['back_text'], true)).toBe('learning_side');
    expect(cardTextMode(['front_text', 'back_text'], true)).toBe('both_sides');
  });

  test('asking only for audio rewrites no text', () => {
    expect(cardTextMode(['back_audio_path'], true)).toBe('none');
    expect(cardTextMode([], true)).toBe('none');
  });

  test('a rewrite with no card to rewrite is not a generation', () => {
    expect(cardTextMode(['front_text'], false)).toBe('none');
  });
});

// ========================
// CARD TEXT
// ========================

describe('generateCardText: a new card', () => {
  const request = {
    userInput: 'date',
    knownLanguage: 'en',
    learningLanguage: 'ko',
    currentCard: null,
    regenerateParts: [],
  };

  test('asks with the generation prompts and assembles one speakable card', async () => {
    const openai = scriptedClient({
      chat: [jsonMessage({
        known_text: 'date',
        learning_text: '날짜',
        sense_tag: 'calendar day',
        register: 'polite',
        spoken_reading: '',
      })],
    });

    const card = await generateCardText(contextFor(openai), request);

    expect(openai.calls.chat).toHaveLength(1);
    const [body] = openai.calls.chat;
    expect(body.model).toBe(CARD_MODELS.text);
    expect(body.messages).toEqual([
      { role: 'system', content: CARD_GENERATION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildCardGenerationPrompt({
          userInput: 'date',
          knownLanguage: 'en',
          learningLanguage: 'ko',
        }),
      },
    ]);
    expect(body.response_format).toBe(GENERATED_CARD_FORMAT);

    // The sense label is on the side nobody speaks; the learning side is bare.
    expect(card).toEqual({
      front_text: 'date (calendar day)',
      back_text: '날짜',
      spoken_reading: '',
    });
  });

  test('labels a register only when it is not the one the app promises', async () => {
    const formal = scriptedClient({
      chat: [jsonMessage({
        known_text: 'Thank you',
        learning_text: '감사합니다',
        sense_tag: '',
        register: 'formal',
        spoken_reading: '',
      })],
    });
    const card = await generateCardText(contextFor(formal), request);
    expect(card.front_text).toBe('Thank you (formal)');

    const polite = scriptedClient({
      chat: [jsonMessage({
        known_text: 'Thank you',
        learning_text: '고마워요',
        sense_tag: '',
        register: 'polite',
        spoken_reading: '',
      })],
    });
    expect((await generateCardText(contextFor(polite), request)).front_text).toBe('Thank you');
  });

  test('keeps the reading where the script hides it, and drops it where it does not', async () => {
    const japanese = scriptedClient({
      chat: [jsonMessage({
        known_text: 'I went',
        learning_text: '行きました',
        sense_tag: '',
        register: 'polite',
        spoken_reading: 'ikimashita',
      })],
    });
    const jaCard = await generateCardText(contextFor(japanese), { ...request, learningLanguage: 'ja' });
    expect(jaCard.spoken_reading).toBe('ikimashita');

    // Hangul is phonemic: a romanisation would only be a second thing to keep
    // in step with the text.
    const korean = scriptedClient({
      chat: [jsonMessage({
        known_text: 'I went',
        learning_text: '갔어요',
        sense_tag: '',
        register: 'polite',
        spoken_reading: 'gasseoyo',
      })],
    });
    expect((await generateCardText(contextFor(korean), request)).spoken_reading).toBe('');
  });

  test('tells the model which rule it broke and takes the second answer', async () => {
    const warnings = [];
    const openai = scriptedClient({
      chat: [
        jsonMessage({
          known_text: 'date',
          learning_text: '날짜 (달력상의 날짜), 데이트 (연애 약속)',
          sense_tag: '',
          register: 'polite',
          spoken_reading: '',
        }),
        jsonMessage({
          known_text: 'date',
          learning_text: '날짜',
          sense_tag: 'calendar day',
          register: 'polite',
          spoken_reading: '',
        }),
      ],
    });

    const card = await generateCardText(
      contextFor(openai, { warn: (m) => warnings.push(m), error: () => {} }),
      request,
    );

    expect(openai.calls.chat).toHaveLength(2);
    const originalPrompt = buildCardGenerationPrompt({
      userInput: 'date',
      knownLanguage: 'en',
      learningLanguage: 'ko',
    });
    expect(openai.calls.chat[1].messages[1].content).toBe(
      buildUnspeakableRetryPrompt(
        originalPrompt,
        '날짜 (달력상의 날짜), 데이트 (연애 약속)',
        'it contains a parenthesized gloss or annotation',
      ),
    );
    expect(card.back_text).toBe('날짜');
    expect(warnings[0]).toContain('Unspeakable ko text on attempt 1/2');
  });

  test('falls back to the repaired text when the model will not comply twice', async () => {
    const unspeakable = {
      known_text: 'date',
      learning_text: '날짜 / 데이트',
      sense_tag: '',
      register: 'polite',
      spoken_reading: '',
    };
    const openai = scriptedClient({ chat: [jsonMessage(unspeakable), jsonMessage(unspeakable)] });

    const card = await generateCardText(contextFor(openai), request);

    expect(openai.calls.chat).toHaveLength(2);
    expect(card.back_text).toBe('날짜');
  });

  test('a response with no content is a failure, not an empty card', async () => {
    const openai = scriptedClient({ chat: [{ choices: [{ message: { content: null } }] }] });
    await expect(generateCardText(contextFor(openai), request)).rejects.toThrow(
      'Failed to parse flashcard_generation from model response',
    );
  });
});

describe('generateCardText: rewriting one side', () => {
  const current = {
    front_text: 'date (calendar day)',
    back_text: '날짜',
    spoken_reading: '',
  };

  test('the known side is rewritten and relabelled; the learning side does not move', async () => {
    const openai = scriptedClient({
      chat: [jsonMessage({ known_text: 'calendar date', sense_tag: 'calendar day', register: 'formal' })],
    });

    const card = await generateCardText(contextFor(openai), {
      userInput: 'date',
      knownLanguage: 'en',
      learningLanguage: 'ko',
      currentCard: current,
      regenerateParts: ['front_text'],
    });

    const [body] = openai.calls.chat;
    expect(body.messages).toEqual([
      { role: 'system', content: CARD_REGENERATION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildKnownSideRegenerationPrompt({
          knownLanguage: 'en',
          learningLanguage: 'ko',
          learningText: '날짜',
          rejectedKnownText: 'date (calendar day)',
        }),
      },
    ]);
    expect(body.response_format).toBe(KNOWN_SIDE_FORMAT);
    expect(card.front_text).toBe('calendar date (calendar day \u00b7 formal)');
    expect(card.back_text).toBe('날짜');
  });

  test('the learning side is rewritten and the old labels are replaced, not stacked', async () => {
    const openai = scriptedClient({
      chat: [jsonMessage({
        learning_text: '데이트',
        sense_tag: 'romantic outing',
        register: 'polite',
        spoken_reading: '',
      })],
    });

    const card = await generateCardText(contextFor(openai), {
      userInput: 'date',
      knownLanguage: 'en',
      learningLanguage: 'ko',
      currentCard: current,
      regenerateParts: ['back_text'],
    });

    const [body] = openai.calls.chat;
    expect(body.messages[1].content).toBe(buildLearningSideRegenerationPrompt({
      knownLanguage: 'en',
      learningLanguage: 'ko',
      knownText: 'date (calendar day)',
      rejectedLearningText: '날짜',
      userInput: 'date',
    }));
    expect(body.response_format).toBe(LEARNING_SIDE_FORMAT);
    // The learner's own wording survives; only the label describing the back
    // side is rewritten.
    expect(card.front_text).toBe('date (romantic outing)');
    expect(card.back_text).toBe('데이트');
  });

  test('both sides are written again from the original meaning', async () => {
    const openai = scriptedClient({
      chat: [jsonMessage({
        known_text: 'What day is it?',
        learning_text: '오늘 며칠이에요?',
        sense_tag: '',
        register: 'polite',
        spoken_reading: '',
      })],
    });

    const card = await generateCardText(contextFor(openai), {
      userInput: 'date',
      knownLanguage: 'en',
      learningLanguage: 'ko',
      currentCard: current,
      regenerateParts: ['front_text', 'back_text'],
    });

    expect(openai.calls.chat[0].messages[1].content).toBe(buildBothSidesRegenerationPrompt({
      knownLanguage: 'en',
      learningLanguage: 'ko',
      knownText: 'date (calendar day)',
      learningText: '날짜',
      userInput: 'date',
    }));
    expect(openai.calls.chat[0].response_format).toBe(GENERATED_CARD_FORMAT);
    expect(card).toEqual({
      front_text: 'What day is it?',
      back_text: '오늘 며칠이에요?',
      spoken_reading: '',
    });
  });

  test('regenerating only the audio calls no model and keeps the reading', async () => {
    const openai = scriptedClient();
    const card = await generateCardText(contextFor(openai), {
      knownLanguage: 'en',
      learningLanguage: 'ja',
      currentCard: { front_text: 'I went', back_text: '行きました', spoken_reading: 'ikimashita' },
      regenerateParts: ['back_audio_path'],
    });

    expect(openai.calls.chat).toHaveLength(0);
    expect(card).toEqual({
      front_text: 'I went',
      back_text: '行きました',
      spoken_reading: 'ikimashita',
    });
  });

  test('a rewrite with no card to rewrite fails rather than inventing one', async () => {
    const openai = scriptedClient();
    await expect(generateCardText(contextFor(openai), {
      knownLanguage: 'en',
      learningLanguage: 'ko',
      currentCard: null,
      regenerateParts: ['front_text'],
    })).rejects.toThrow('Failed to generate or retrieve card data');
  });
});

// ========================
// AUDIO
// ========================

describe('getTtsInstructions', () => {
  test('asks for the language the card promises', () => {
    expect(getTtsInstructions('ko')).toContain('한국어 원어민처럼');
    expect(getTtsInstructions('zh_hk')).toContain('廣東話');
    // The app's own codes are all spelled out; anything else gets the template.
    expect(getTtsInstructions('eo')).toBe(
      'Speak like a native speaker of eo. Use proper pronunciation and intonation for language learning purposes.',
    );
  });
});

describe('generateCardAudio', () => {
  test('speaks only the spoken form and accepts a matching transcript without a judge', async () => {
    const openai = scriptedClient({ transcription: [{ text: 'Goodbye.' }] });

    const audio = await generateCardAudio(contextFor(openai), {
      text: 'Goodbye (to someone leaving)',
      language: 'en',
    });

    expect(openai.calls.speech[0]).toEqual({
      model: CARD_MODELS.tts,
      voice: 'alloy',
      input: 'Goodbye',
      instructions: getTtsInstructions('en'),
    });
    expect(openai.calls.transcription[0].model).toBe(CARD_MODELS.transcribe);
    expect(openai.calls.transcription[0].language).toBe('en');
    // No second opinion was needed, so none was paid for.
    expect(openai.calls.chat).toHaveLength(0);
    expect(await clipByte(audio)).toBe(1);
  });

  test('transcribes Cantonese as Cantonese', async () => {
    const openai = scriptedClient({ transcription: [{ text: '你好' }] });
    await generateCardAudio(contextFor(openai), { text: '你好', language: 'zh_hk', reading: 'nei5 hou2' });
    expect(openai.calls.transcription[0].language).toBe('yue');
  });

  test('a matching transcript is not enough when the script hides the reading', async () => {
    const openai = scriptedClient({
      transcription: [{ text: '行った' }],
      chat: [judgement({ matches: true, heard: 'itta', reason: 'reads as itta' })],
    });

    const audio = await generateCardAudio(contextFor(openai), {
      text: '行った',
      language: 'ja',
      reading: 'itta',
    });

    // The reading steers the synthesiser as well as the judge.
    expect(openai.calls.speech[0].instructions).toBe(
      `${getTtsInstructions('ja')}\n\nRead the text with exactly this pronunciation: itta`,
    );
    const judgeCall = openai.calls.chat[0];
    expect(judgeCall.model).toBe(CARD_MODELS.speechEvaluation);
    expect(judgeCall.tool_choice).toEqual({ type: 'function', function: { name: 'judge_audio' } });
    expect(judgeCall.messages[1].content[0].text).toContain('It must be read aloud as: itta');
    expect(judgeCall.messages[1].content[1].input_audio.format).toBe('mp3');
    expect(await clipByte(audio)).toBe(1);
  });

  test('says out loud when an opaque script has no reading to check against', async () => {
    const warnings = [];
    const openai = scriptedClient({ transcription: [{ text: '行った' }] });

    await generateCardAudio(
      contextFor(openai, { warn: (m) => warnings.push(m), error: () => {} }),
      { text: '行った', language: 'ja' },
    );

    expect(warnings[0]).toContain('No expected reading');
    expect(openai.calls.chat).toHaveLength(0);
  });

  test('rotates the voice after a rejected clip and keeps the one that passes', async () => {
    const openai = scriptedClient({
      transcription: [{ text: '배고프세요?' }, { text: '배고파요?' }],
      chat: [judgement({ matches: false, heard: '배고프세요', reason: 'different ending' })],
    });

    const audio = await generateCardAudio(contextFor(openai), { text: '배고파요?', language: 'ko' });

    expect(openai.calls.speech.map((call) => call.voice)).toEqual(['alloy', 'nova']);
    expect(await clipByte(audio)).toBe(2);
  });

  test('fails closed rather than shipping audio that was never accepted', async () => {
    const openai = scriptedClient({
      transcription: [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      chat: [
        judgement({ matches: false, heard: 'a', reason: 'wrong' }),
        judgement({ matches: false, heard: 'b', reason: 'wrong' }),
        judgement({ matches: false, heard: 'c', reason: 'wrong' }),
      ],
    });

    await expect(generateCardAudio(contextFor(openai), { text: '날짜', language: 'ko' }))
      .rejects.toThrow('Failed to generate valid audio for "날짜" after 3 attempts');
    expect(openai.calls.speech).toHaveLength(3);
  });

  test('a synthesis outage is retried, not swallowed', async () => {
    const errors = [];
    const openai = scriptedClient({
      speech: [new Error('503 upstream'), { arrayBuffer: async () => new Uint8Array([9]).buffer }],
      transcription: [{ text: '날짜' }],
    });

    const audio = await generateCardAudio(
      contextFor(openai, { warn: () => {}, error: (m) => errors.push(m) }),
      { text: '날짜', language: 'ko' },
    );

    expect(errors[0]).toContain('Audio generation attempt 1/3 failed: 503 upstream');
    expect(await clipByte(audio)).toBe(9);
  });

  test('a judge outage with a matching transcript ships the clip and says the reading is unverified', async () => {
    const warnings = [];
    const openai = scriptedClient({
      transcription: [{ text: '行った' }],
      chat: [new Error('judge is down')],
    });

    const audio = await generateCardAudio(
      contextFor(openai, { warn: (m) => warnings.push(m), error: () => {} }),
      { text: '行った', language: 'ja', reading: 'itta' },
    );

    expect(warnings.join('\n')).toContain('accepting "行った" on transcript equality with its reading unverified');
    expect(await clipByte(audio)).toBe(1);
  });

  test('a judge outage with a mismatched transcript falls back to judging the transcript', async () => {
    const openai = scriptedClient({
      transcription: [{ text: 'twenty four seven' }],
      chat: [new Error('judge is down'), jsonMessage({ matches: true })],
    });

    const audio = await generateCardAudio(contextFor(openai), { text: '24/7', language: 'en' });

    const fallback = openai.calls.chat[1];
    expect(fallback.model).toBe(CARD_MODELS.text);
    expect(fallback.response_format.json_schema.name).toBe('transcription_match');
    expect(fallback.messages[1].content).toContain('Transcription: "twenty four seven"');
    expect(await clipByte(audio)).toBe(1);
  });
});
