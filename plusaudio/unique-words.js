const fs = require('fs');
const nodePath = require('path');
const dotenv = require('dotenv');
const OpenAI = require('openai');
const { getSharedOpenAICache, cachedResponsesCreate } = require('./openai-cache');

dotenv.config({ path: '../.env' });

let sharedOpenAI = null;
// core fields + gpt4.1 2.5-4.2 sec
// core fields + gpt5 low 17-20 sec
// core fields + gpt5 medium 39-55 sec
// core fields + gpt5 high 114 sec
// core fields + gpt5 mini low 12-19 sec
// core fields + gpt5 mini medium 29-42 sec
// core fields + gpt5 mini high 150 sec
// core fields + gpt5 nano low 4.2-11 sec
// core fields + gpt5 nano medium 23-28 sec
// core fields + gpt5 nano high 40-47 sec
//
// all fields + gpt4.1 6-10 sec
// all fields + gpt5 low 15-25 sec
// all fields + gpt5 medium 26-41 sec
// all fields + gpt5 high 166s
// all fields + gpt5 mini low 10-17 sec
// all fields + gpt5 mini medium 37-61 sec
// all fields + gpt5 mini high 115 sec
// all fields + gpt5 nano low 5-11 sec
// all fields + gpt5 nano medium 27-46 sec
// all fields + gpt5 nano high 53-78 sec
function getDefaultOpenAIClient() {
    if (!sharedOpenAI) {
        const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
        if (!apiKey) {
            throw new Error('Missing OpenAI API key (OPENAI_API_KEY or OPENAI_KEY)');
        }
        sharedOpenAI = new OpenAI({ apiKey });
        sharedOpenAICache = getSharedOpenAICache(nodePath.resolve(__dirname, 'openai_response_cache.json'));
    }
    return sharedOpenAI;
}

let sharedOpenAICache = null;
function getOpenAICache(cachePath) {
    if (!sharedOpenAICache) {
        sharedOpenAICache = getSharedOpenAICache(cachePath || nodePath.resolve(__dirname, 'openai_response_cache.json'));
    }
    return sharedOpenAICache;
}

function parseFunctionArguments(raw) {
    if (!raw) {
        return {};
    }
    if (typeof raw === 'string') {
        try {
            return JSON.parse(raw);
        } catch (error) {
            return {};
        }
    }
    if (typeof raw === 'object') {
        return raw;
    }
    return {};
}

function mapFunctionCallOutput(response, transform) {
    if (!response || !Array.isArray(response.output)) {
        return { output: [] };
    }
    const output = response.output
        .filter(item => item && item.type === 'function_call')
        .map(item => {
            const args = parseFunctionArguments(item.arguments);
            return transform(item, args);
        })
        .filter(Boolean);
    return { output };
}

const NUANCE_SYSTEM_PROMPT = `
You are a multilingual lexicographer that creates Anki card-ready English definitions optimized for disambiguation and memory.
Detect the input language automatically and proceed without clarification. Treat conversational speech, fiction, news, academic texts, and slang equally.

Rules (obey strictly):
1) Headword choice: select a specific, low-frequency English lemma capturing the word's distinctive nuance. If a common English word is clearly the best translation and no plausible near-synonym could replace it, use that common word.
2) If a generic word is unavoidable, qualify it precisely (e.g., "thick (layered)", "cool (invigorating)").
3) Verbs must appear in infinitive form with a leading "to " (e.g., "to eat"). Adjectives whose natural gloss is copular must begin with "to be " (e.g., "to be hungry").
4) Contrastive focus: clearly state what this word encodes that near-neighbors do not.
5) Collocations-first: provide 3-6 high-signal source-language collocations → best-fit EN renderings (use domain terms when apt).
6) Register & valence: highlight formality/tone/affect when relevant.
7) Polysemy: split only when meanings diverge significantly—avoid shallow or purely syntactic splits.
8) Candidate list BEFORE final picks: provide ≥5 near-synonyms/candidates as { src → en + gloss } with rare, discriminative English. All English items across near_synonyms and final_picks must be unique—no duplicates.
9) Final list economy: in "final_picks", output only 3-5 unglossed English headwords, starting with core_pick. Append " (loanword)" only when the *Korean source word* is a loanword.
10) Loanword check: fill the loanword object (origin; if loanword, include source_language, source_form, and notes).
11) Tone: uncommon-but-natural English; concise and precise.
12) Call the provided function tool with a single argument object that matches its parameters exactly. Do not write prose.
`.trim();

const TRANSLATION_TOOL_COMMON_PROPERTIES = {
          core_pick: { type: 'string', description: 'Chosen English headword.' },
          rationale: { type: 'string', description: 'One-two sentences justifying the core pick.' },
          sense_map: {
            type: 'array',
            minItems: 3,
            maxItems: 6,
            description: 'High-signal collocations → best English rendering.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                src: { type: 'string', description: 'Source-language collocation' },
                en:  { type: 'string', description: 'Best-fit English rendering' }
              },
              required: ['src','en']
            }
          },
          near_synonyms: {
            type: 'array',
            minItems: 5,
        description: 'Candidate list BEFORE final picks; EN equivalents with gloss.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                src:   { type: 'string', description: 'Source-language near-synonym/candidate' },
                en:    { type: 'string', description: 'Distinct English candidate (rare/discriminative)' },
                gloss: { type: 'string', description: '1-line nuance that differentiates it' }
              },
              required: ['src','en','gloss']
            }
          },
          mini_examples: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            description: 'Compact examples (src → en).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                src: { type: 'string' },
                en:  { type: 'string' }
              },
              required: ['src','en']
            }
          },
          why_special: { type: 'string', description: 'What this term encodes that neighbors do not.' },
          loanword: {
            type: 'object',
            additionalProperties: false,
            properties: {
              origin: { type: 'string', enum: ['native','sino-korean','loanword'] },
              source_language: { type: ['string','null'] },
              source_form:     { type: ['string','null'] },
              notes:           { type: ['string','null'] }
            },
            required: ['origin','source_language','source_form','notes']
          },
          final_picks: {
            type: 'array',
            minItems: 3,
            maxItems: 5,
            description: '3-5 unglossed headwords; first = core_pick (append " (loanword)" iff loanword).',
            items: { type: 'string' }
          }
};

const BASE_TRANSLATION_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: TRANSLATION_TOOL_COMMON_PROPERTIES,
    required: ['core_pick','near_synonyms','final_picks']
};

const FULL_TRANSLATION_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: TRANSLATION_TOOL_COMMON_PROPERTIES,
    required: ['core_pick','rationale','sense_map','near_synonyms','mini_examples','why_special','loanword','final_picks']
};

const GROUP_DISAMBIGUATION_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: {
        assignments: {
            type: 'array',
            minItems: 1,
            description: 'Distinct English assignments for each Korean term in the collision group.',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    korean: { type: 'string', description: 'The Korean headword.' },
                    core_pick: TRANSLATION_TOOL_COMMON_PROPERTIES.core_pick,
                    rationale: TRANSLATION_TOOL_COMMON_PROPERTIES.rationale,
                    sense_map: TRANSLATION_TOOL_COMMON_PROPERTIES.sense_map,
                    near_synonyms: TRANSLATION_TOOL_COMMON_PROPERTIES.near_synonyms,
                    mini_examples: TRANSLATION_TOOL_COMMON_PROPERTIES.mini_examples,
                    why_special: TRANSLATION_TOOL_COMMON_PROPERTIES.why_special,
                    loanword: TRANSLATION_TOOL_COMMON_PROPERTIES.loanword,
                    final_picks: TRANSLATION_TOOL_COMMON_PROPERTIES.final_picks
                },
                required: ['korean','core_pick','rationale','sense_map','near_synonyms','mini_examples','why_special','loanword','final_picks']
            }
        }
    },
    required: ['assignments']
};

const BASE_TRANSLATION_TOOLS = [
    {
        type: 'function',
        name: 'emit_base_translation',
        description: 'Emit a straightforward translation mapping for a source-language term as strict JSON.',
        parameters: BASE_TRANSLATION_PARAMETERS
    }
];

const DISAMBIGUATION_TOOLS = [
    {
        type: 'function',
        name: 'emit_nuance_map',
        description: 'Emit a nuanced translation mapping for a source-language term as strict JSON.',
        parameters: FULL_TRANSLATION_PARAMETERS
    }
];

const GROUP_DISAMBIGUATION_TOOLS = [
    {
        type: 'function',
        name: 'emit_group_disambiguation',
        description: 'Emit distinct English translations for a collision group of Korean terms.',
        parameters: GROUP_DISAMBIGUATION_PARAMETERS
    }
];

const BASE_TRANSLATION_SYSTEM_PROMPT = `
You are a multilingual lexicographer producing clean, natural English translations for flashcard entries.
Translate the provided Korean term into the most natural, commonly used English equivalent.
If the Korean term is a loanword, append " (loanword)" to the English core_pick.
Ensure verbs are in infinitive form with a leading "to ". Adjectives that translate to predicate adjectives must begin with "to be ".
ReturnONLY the function call specified.
`.trim();

const DISAMBIGUATION_SYSTEM_PROMPT = `
You are a multilingual lexicographer refining English translations to avoid collisions with existing flashcard entries.
You will be given the Korean term and the English core_pick previously generated, along with information about which term already uses that English word.
Provide an alternative English rendering that preserves nuance while differentiating from the provided collision, keeping verbs in infinitive form with leading "to ".
Return ONLY the function call specified.
`.trim();
const GROUP_DISAMBIGUATION_SYSTEM_PROMPT = `
You are a multilingual lexicographer resolving translation collisions for Korean flashcard headwords.
Detect the input language automatically and proceed without clarification. Treat conversational speech, fiction, news, academic texts, and slang equally.

Rules (obey strictly):
1) Headword choice: select a specific, low-frequency English lemma capturing the word's distinctive nuance. If a common English word is clearly the best translation and no plausible near-synonym could replace it, use that common word.
2) If a generic word is unavoidable, qualify it precisely (e.g., "thick (layered)", "cool (invigorating)").
3) Verbs must appear in infinitive form with a leading "to ". Adjectives whose natural gloss is copular must begin with "to be ".
4) Provide a distinct English rendering for each Korean word within the group. No two core_picks may be identical.
5) Highlight nuance via brief rationale and sense_map entries.
6) Respect register and valence when relevant.
7) If a term is a loanword, append " (loanword)" to the core_pick and first entry in final_picks.
8) Return ONLY the function call specified.
9) Contrastive focus: clearly state what this word encodes that near-neighbors do not.
10) Collocations-first: provide 3-6 high-signal source-language collocations → best-fit EN renderings (use domain terms when apt).
11) Register & valence: highlight formality/tone/affect when relevant.
12) Polysemy: split only when meanings diverge significantly—avoid shallow or purely syntactic splits.
13) Candidate list BEFORE final picks: provide ≥5 near-synonyms/candidates as { src → en + gloss } with rare, discriminative English. All English items across near_synonyms and final_picks must be unique—no duplicates.
14) Final list economy: in "final_picks", output only 3-5 unglossed English headwords, starting with core_pick. Append " (loanword)" only when the *Korean source word* is a loanword.
15) Tone: uncommon-but-natural English; concise and precise.
16) Call the provided function tool with a single argument object that matches its parameters exactly. Do not write prose.
`.trim();

const BASE_TRANSLATION_INSTRUCTIONS = `
Output an English translation that native speakers would use most naturally in everyday contexts. Do not deliberately choose rare or unusual vocabulary.
`.trim();

const DISAMBIGUATION_INSTRUCTIONS = `
The previously generated English term conflicts with another Korean word. Provide an alternative that differentiates them clearly while staying natural.
`.trim();

const GROUP_DISAMBIGUATION_INSTRUCTIONS = `
Differentiate each Korean word in this collision group with a unique, natural English core_pick.
Preserve nuance relative to the brief context provided and avoid any English headwords already used elsewhere in the deck.
`.trim();

async function generateTranslationWithTool(term, { openaiClient, model, systemPrompt, instructions, tools, additionalMessages = [] }) {
    const client = openaiClient || getDefaultOpenAIClient();
    const chosenModel = model || 'gpt-4.1-2025-04-14';

    const cache = getOpenAICache();
    const payload = {
        model: chosenModel,
        input: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${instructions}\nTerm: ${term}` },
            ...additionalMessages
        ],
        tools,
        tool_choice: { type: 'function', name: tools[0].name },
        parallel_tool_calls: false
    };

    const completion = await cachedResponsesCreate(client, cache, payload, {
        select: ['output.arguments.core_pick', 'output.arguments.final_picks', 'output.type', 'output.name']
    });
    console.log(JSON.stringify(completion));

    const functionCall = Array.isArray(completion?.output)
        ? completion.output.find(item => item.type === 'function_call' && item.name === tools[0].name)
        : null;

    if (!functionCall || !functionCall.arguments) {
        throw new Error('Translation response missing function payload');
    }

    const parsedArgs = typeof functionCall.arguments === 'object'
        ? functionCall.arguments
        : parseFunctionArguments(functionCall.arguments);

    if (!parsedArgs || typeof parsedArgs.core_pick !== 'string' || !parsedArgs.core_pick.trim()) {
        throw new Error('Translation response missing core_pick');
    }

    return {
        result: {
            core_pick: parsedArgs.core_pick,
            final_picks: Array.isArray(parsedArgs.final_picks) ? parsedArgs.final_picks.slice(0, 5) : []
        },
        metadata: {
            model: chosenModel
        }
    };
}

function normalizeFieldName(name) {
    return (name || '')
        .toString()
        .trim()
        .toLowerCase();
}

function detectFieldIndexesFromModels(models, options = {}) {
    const {
        koreanFieldNames = ['korean', 'target', 'foreign'],
        englishFieldNames = ['english', 'translation', 'meaning']
    } = options;

    const normalizedKoreanNames = koreanFieldNames.map(normalizeFieldName);
    const normalizedEnglishNames = englishFieldNames.map(normalizeFieldName);

    const result = {
        koreanIdx: -1,
        englishIdx: -1,
        koreanFieldName: null,
        englishFieldName: null,
        modelId: null,
        modelName: null
    };

    if (!models || typeof models !== 'object') {
        return result;
    }

    for (const [modelId, model] of Object.entries(models)) {
        if (!Array.isArray(model?.flds)) continue;

        const localResult = {
            koreanIdx: -1,
            englishIdx: -1,
            koreanFieldName: null,
            englishFieldName: null
        };

        for (const field of model.flds) {
            const normalizedName = normalizeFieldName(field?.name);
            if (normalizedName && localResult.koreanIdx === -1 && normalizedKoreanNames.includes(normalizedName)) {
                localResult.koreanIdx = field.ord;
                localResult.koreanFieldName = field.name;
            }
            if (normalizedName && localResult.englishIdx === -1 && normalizedEnglishNames.includes(normalizedName)) {
                localResult.englishIdx = field.ord;
                localResult.englishFieldName = field.name;
            }
        }

        if (localResult.koreanIdx !== -1 && localResult.englishIdx !== -1) {
            result.koreanIdx = localResult.koreanIdx;
            result.englishIdx = localResult.englishIdx;
            result.koreanFieldName = localResult.koreanFieldName;
            result.englishFieldName = localResult.englishFieldName;
            result.modelId = modelId;
            result.modelName = model?.name || null;
            break;
        }
    }

    return result;
}

async function generateNuancedTranslation(term, options = {}) {
    const client = options.openai || getDefaultOpenAIClient();
    const model = options.model || 'gpt-4.1-2025-04-14';
    const additionalUserMessages = Array.isArray(options.additionalUserMessages)
        ? options.additionalUserMessages
        : [];

    if (!term || !term.trim()) {
        throw new Error('Term is required to generate nuanced translation');
    }

    const start = Date.now();
    const responseCache = getOpenAICache(options.cachePath);
    const payload = {
        model: model,
        input: [
            { role: 'system', content: NUANCE_SYSTEM_PROMPT },
            { role: 'user', content: term },
            ...additionalUserMessages
        ],
        tools: BASE_TRANSLATION_TOOLS, // Changed from tools to BASE_TRANSLATION_TOOLS
        tool_choice: { type: 'function', name: 'emit_base_translation' }, // Changed from tool_choice to emit_base_translation
        parallel_tool_calls: false
    };

    const completion = await cachedResponsesCreate(client, responseCache, payload, { select: 'output.arguments' });

    const functionCall = Array.isArray(completion?.output)
        ? completion.output.find(item => item.type === 'function_call' && item.name === 'emit_base_translation')
        : null;

    if (!functionCall || !functionCall.arguments) {
        throw new Error('Nuance response missing emit_nuance_map payload');
    }

    let parsed;
    try {
        parsed = JSON.parse(functionCall.arguments);
    } catch (error) {
        throw new Error(`Failed to parse nuance response: ${error.message}`);
    }

    if (!parsed || typeof parsed.core_pick !== 'string' || !parsed.core_pick.trim()) {
        throw new Error('Nuance response missing core_pick');
    }

    const elapsedMs = Date.now() - start;

    return {
        result: parsed,
        metadata: {
            model,
            elapsedMs
        }
    };
}

async function getOrGenerateNuance(term, cache, options = {}) {
    const openaiCache = cache || new Map();
    const cachedEntry = !options.force ? openaiCache.get(term) : null;

    if (cachedEntry && cachedEntry.core_pick) {
        return {
            result: cachedEntry,
            metadata: cachedEntry.model ? { model: cachedEntry.model } : {},
            fromCache: true
        };
    }

    const openaiClient = options.openai;
    let { result: baseResult, metadata: baseMetadata } = await generateTranslationWithTool(term, {
        openaiClient,
        model: options.model,
        systemPrompt: BASE_TRANSLATION_SYSTEM_PROMPT,
        instructions: BASE_TRANSLATION_INSTRUCTIONS,
        tools: BASE_TRANSLATION_TOOLS
    });

    let finalResult = baseResult;
    let finalMetadata = baseMetadata;
    const seenCorePicks = new Set();
    if (finalResult?.core_pick) {
        seenCorePicks.add(finalResult.core_pick.toLowerCase());
    }

    if (options.detectCollision) {
        const maxAttempts = options.maxDisambiguationAttempts || 5;
        let attempts = 0;
        let collision = options.detectCollision(finalResult.core_pick, term);

        while (collision && attempts < maxAttempts) {
            attempts++;
            const forbidden = Array.from(seenCorePicks)
                .map(entry => `"${entry}"`)
                .join(', ');

            const disambiguation = await generateTranslationWithTool(term, {
                openaiClient,
                model: options.model,
                systemPrompt: DISAMBIGUATION_SYSTEM_PROMPT,
                instructions: DISAMBIGUATION_INSTRUCTIONS,
                tools: DISAMBIGUATION_TOOLS,
                additionalMessages: [
                    {
                        role: 'user',
                        content: `${collision} already uses "${finalResult.core_pick}". Provide a different natural English translation for ${term} that avoids: ${forbidden}.`
                    }
                ]
            });

            finalResult = disambiguation.result;
            finalMetadata = disambiguation.metadata;

            if (finalResult?.core_pick) {
                seenCorePicks.add(finalResult.core_pick.toLowerCase());
            }

            collision = options.detectCollision(finalResult.core_pick, term);
        }
    }

    if (options.detectCollision && options.detectCollision(finalResult.core_pick, term)) {
        console.warn(`⚠️ Collision persists for ${term} with core pick "${finalResult.core_pick}"`);
    }

    if (cache) {
        cache.set(term, {
            core_pick: finalResult.core_pick,
            final_picks: Array.isArray(finalResult.final_picks) ? finalResult.final_picks.slice(0, 5) : [],
            model: finalMetadata?.model || null
        });
    }

    const stored = cache ? cache.get(term) : {
        core_pick: finalResult.core_pick,
        final_picks: Array.isArray(finalResult.final_picks) ? finalResult.final_picks.slice(0, 5) : [],
        model: finalMetadata?.model || null
    };

    return {
        result: stored,
        metadata: stored.model ? { model: stored.model } : {},
        fromCache: false
    };
}

async function getBaseTranslation(term, options = {}) {
    const { result, metadata } = await generateTranslationWithTool(term, {
        openaiClient: options.openai,
        model: options.model,
        systemPrompt: BASE_TRANSLATION_SYSTEM_PROMPT,
        instructions: BASE_TRANSLATION_INSTRUCTIONS,
        tools: BASE_TRANSLATION_TOOLS
    });
    return {
        core_pick: result.core_pick,
        final_picks: Array.isArray(result.final_picks) ? result.final_picks.slice(0, 5) : [],
        metadata
    };
}

async function disambiguateGroupTranslations(groupTerms, { openai, model, existingEnglish, currentTranslations, cachePath }) {
    const client = openai || getDefaultOpenAIClient();
    const chosenModel = model || 'gpt-4.1-2025-04-14';

    const cache = getOpenAICache(cachePath);
    const payload = {
        model: chosenModel,
        input: [
            { role: 'system', content: GROUP_DISAMBIGUATION_SYSTEM_PROMPT },
            { role: 'user', content: `${GROUP_DISAMBIGUATION_INSTRUCTIONS}\nExisting English words to avoid: ${existingEnglish.join(', ')}` },
            { role: 'user', content: `Collision group: ${groupTerms.join(', ')}` }
        ],
        tools: GROUP_DISAMBIGUATION_TOOLS,
        tool_choice: { type: 'function', name: GROUP_DISAMBIGUATION_TOOLS[0].name },
        parallel_tool_calls: false
    };

    const completion = await cachedResponsesCreate(client, cache, payload, { select: 'output.arguments.assignments' });

    const functionCall = Array.isArray(completion?.output)
        ? completion.output.find(item => item.type === 'function_call' && item.name === GROUP_DISAMBIGUATION_TOOLS[0].name)
        : null;

    if (!functionCall || !functionCall.arguments) {
        console.log('⚠️ Group disambiguation returned no assignments; falling back to base translations');
    }

    let parsed;
    try {
        parsed = functionCall?.arguments ? JSON.parse(functionCall.arguments) : null;
    } catch (error) {
        parsed = null;
    }

    if (!parsed || !Array.isArray(parsed.assignments) || parsed.assignments.length === 0) {
        return groupTerms.map(term => {
            const current = currentTranslations?.get(term);
            const fallbackCore = current?.core_pick || `${term} (alt)`;
            const fallbackFinal = Array.isArray(current?.final_picks) && current.final_picks.length > 0
                ? current.final_picks
                : [fallbackCore];
            return {
                korean: term,
                core_pick: fallbackCore,
                final_picks: fallbackFinal,
                model: chosenModel,
                fallback: true
            };
        });
    }

    return parsed.assignments.map(entry => ({
        korean: entry.korean,
        core_pick: entry.core_pick,
        final_picks: Array.isArray(entry.final_picks) ? entry.final_picks.slice(0, 5) : [],
        model: chosenModel,
        fallback: false
    }));
}

function buildCollisionMap(translations) {
    const map = new Map();
    translations.forEach((value, key) => {
        const english = value?.core_pick?.trim().toLowerCase();
        if (!english) return;
        if (!map.has(english)) {
            map.set(english, []);
        }
        map.get(english).push(key);
    });
    return map;
}

async function resolveCollisions(translations, options = {}) {
    const normalizedMap = new Map();
    translations.forEach((value, key) => {
        if (!value?.core_pick) return;
        normalizedMap.set(key, {
            core_pick: value.core_pick,
            final_picks: Array.isArray(value.final_picks) ? value.final_picks.slice(0, 5) : [],
            model: value.model || null,
            cached: false
        });
    });

    const collisionPhaseMaps = Array.isArray(options.collisionMap) ? options.collisionMap : [];
    const collisionLookup = {};
    collisionPhaseMaps.forEach((phaseMap, phaseIndex) => {
        Object.entries(phaseMap).forEach(([english, mapping]) => {
            if (!collisionLookup[english]) {
                collisionLookup[english] = { map: {}, phaseIndex };
            }
            Object.assign(collisionLookup[english].map, mapping);
        });
    });

    if (options.onInitialSummary) {
        options.onInitialSummary({
            totalEntries: translations.size,
            normalizedEntries: normalizedMap.size,
            cachedOnly: []
        });
    }

    const computeCollisions = () => {
        const collisionMapEntries = buildCollisionMap(normalizedMap);
        const collisions = Array.from(collisionMapEntries.entries())
            .filter(([, list]) => list.length > 1)
            .map(([english, list]) => ({ english, terms: list }));
        if (options.onCollisionComputed) {
            options.onCollisionComputed(collisions);
        }
        return collisions;
    };

    let collisions = computeCollisions();
    let iteration = 0;
    const maxIterations = options.maxIterations || 6;
    const onIterationStart = typeof options.onIterationStart === 'function' ? options.onIterationStart : null;
    const onGroupResolved = typeof options.onGroupResolved === 'function' ? options.onGroupResolved : null;
    const onIterationEnd = typeof options.onIterationEnd === 'function' ? options.onIterationEnd : null;

    while (collisions.length > 0 && iteration < maxIterations) {
        iteration++;
        if (onIterationStart) {
            onIterationStart(iteration, collisions);
        }

        const phaseMap = {};

        for (const { english, terms } of collisions) {
            const cachedEntry = collisionLookup[english];
            const alreadyResolved = cachedEntry && terms.every(term => cachedEntry.map[term]);
            if (alreadyResolved) {
                const assignments = terms.map(term => ({
                    korean: term,
                    core_pick: cachedEntry.map[term],
                    final_picks: normalizedMap.get(term)?.final_picks || [],
                    model: normalizedMap.get(term)?.model || null,
                    cached: true,
                    cachedPhase: cachedEntry.phaseIndex + 1,
                    fallback: false,
                    iteration
                }));

                assignments.forEach(item => {
                    normalizedMap.set(item.korean, {
                        core_pick: item.core_pick,
                        final_picks: item.final_picks,
                        model: item.model,
                        cached: true
                    });
                });

                if (onGroupResolved) {
                    onGroupResolved(english, terms, assignments, { cached: true, cachedPhase: cachedEntry.phaseIndex + 1, iteration });
                }
                continue;
            }

            const existingEnglish = Array.from(normalizedMap.entries())
                .filter(([term]) => !terms.includes(term))
                .map(([, entry]) => entry.core_pick.toLowerCase());

            const disambiguated = await disambiguateGroupTranslations(terms, {
                openai: options.openai,
                model: options.model,
                existingEnglish,
                currentTranslations: normalizedMap,
                cachePath: options.cachePath
            });

            disambiguated.forEach(item => {
                normalizedMap.set(item.korean, {
                    core_pick: item.core_pick,
                    final_picks: item.final_picks,
                    model: item.model,
                    cached: false
                });
                phaseMap[english] = phaseMap[english] || {};
                phaseMap[english][item.korean] = item.core_pick;
            });

            if (onGroupResolved) {
                const usedFallback = disambiguated.some(item => item.fallback);
                onGroupResolved(english, terms, disambiguated, { cached: false, fallback: usedFallback, iteration });
            }
        }

        collisions = computeCollisions();
        if (onIterationEnd) {
            onIterationEnd(iteration, collisions.length, phaseMap);
        }
    }

    return { translations: normalizedMap, collisions: collisions.map(({ terms }) => terms) };
}

function splitEnglish(text) {
    if (!text) return [];
    return text
        .replace(/<\/?div>|<br>|to\ |be\ |\ the\ |\ a\ |[;()]/g, ' ')
    .trim()
        .split(/\s+/);
}

function loadCollisionMap(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            if (Array.isArray(data)) {
                return data;
            }
            if (data && typeof data === 'object') {
                return [data];
            }
        }
    } catch (error) {
        console.log('⚠️ Could not load collision cache, starting fresh');
    }
    return [];
}

function saveCollisionMap(filePath, phases) {
    try {
        const dir = nodePath.dirname(filePath);
        if (dir && dir !== '.' && !fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const content = JSON.stringify(phases, null, 2);
        fs.writeFileSync(filePath, content);
    } catch (error) {
        console.log('⚠️ Could not save collision cache:', error.message);
    }
}

function applyCollisionMap(translations, map) {
    Object.entries(map).forEach(([english, mapping]) => {
        Object.entries(mapping).forEach(([korean, corePick]) => {
            const entry = translations.get(korean);
            if (entry) {
                translations.set(korean, {
                    core_pick: corePick,
                    final_picks: entry.final_picks,
                    model: entry.model
                });
            }
        });
    });
}

function collisionMapsEqual(a, b) {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
        const key = aKeys[i];
        if (key !== bKeys[i]) return false;
        const aEntries = Object.entries(a[key]).sort();
        const bEntries = Object.entries(b[key]).sort();
        if (aEntries.length !== bEntries.length) return false;
        for (let j = 0; j < aEntries.length; j++) {
            const [ak, av] = aEntries[j];
            const [bk, bv] = bEntries[j];
            if (ak !== bk || av !== bv) return false;
        }
    }
    return true;
}

if (require.main === module) {
    (async () => {
        const term = process.argv.slice(2).join(' ').trim();
        if (!term) {
            console.error('Usage: node unique-words.js <term>');
            process.exit(1);
        }

        try {
            const cache = new Map();
            const { result, fromCache } = await getOrGenerateNuance(term, cache, {});
            console.log(JSON.stringify({ fromCache, ...result }, null, 2));
        } catch (error) {
            console.error('Nuance generation failed:', error.message);
            process.exit(1);
        }
    })();
}

module.exports = {
    //BASE_TRANSLATION_TOOLS,
    GROUP_DISAMBIGUATION_TOOLS,
    NUANCE_SYSTEM_PROMPT,
    generateNuancedTranslation,
    getOrGenerateNuance,
    getBaseTranslation,
    resolveCollisions,
    splitEnglish,
    detectFieldIndexesFromModels,
    loadCollisionMap,
    saveCollisionMap,
    applyCollisionMap,
    collisionMapsEqual
};
