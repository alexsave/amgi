const yauzl = require('yauzl');
const { z } = require('zod');
const Database = require('better-sqlite3');
const { zodResponseFormat } = require('openai/helpers/zod');
const dotenv = require('dotenv');
const OpenAI = require('openai');

dotenv.config({ path: '../.env' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY });

const args = process.argv.slice(2);

const inputFile = args[0];

const gen = async () => new Promise((res, rej) => {
    yauzl.open(inputFile, { lazyEntries: true }, async(err, zipFile) => {
            zipFile.readEntry();
            zipFile.on('entry', entry => {
                    if(entry.fileName === 'collection.anki21'){
                            zipFile.openReadStream(entry, async (err, readStream) => {
                                    const chunks = [];
                                    readStream.on('data', chunk => chunks.push(chunk));
                                    readStream.on('end', async () => {
                                            const buffer = Buffer.concat(chunks);
                                            const db = new Database(buffer);

                                            // Looking at all tables. Somewhere in anki, the actual field names are explained. But where?
                                            // It's definitely in the col table
                                            // Looks like there's only one row in col
                                            // It has a type called models
                                            // this has a single field for the id of the deck
                                            // col in general has a fucking lot, i'm surprised we were even able to recreate the deck at a ll
                                            // the deck has a name and tmpls, and flds
                                            // finally flds is pretty useful


                                            // Detect fields
                                            const col = db.prepare(`SELECT * FROM col LIMIT 1`).get();
                                            const models = JSON.parse(col.models);
                                            const deck = models[Object.keys(models)[0]];
                                            const flds = deck.flds;

                                            // Expand this to more languages later
                                            let koreanIdx = -1;
                                            let englishIdx = -1;

                                            for (fld of flds) {
                                                // A bit of an assumption here. Ideally we pass all {name,ord} to GPT
                                                // But this saves a call
                                                    if (fld.name === 'Korean')
                                                            koreanIdx = fld.ord;
                                                    if (fld.name === 'English') 
                                                            englishIdx = fld.ord;
                                            }

                                            // Now we're going to look at the english to come up with a grouping of sort. like a posting list
                                            const postingList = {};

                                            const allNotes = db.prepare('SELECT id, flds FROM notes ORDER BY id').all();
                                            let i = 0;
                                            for (const note of allNotes) {
                                                    i++;
                                                    const fields = note.flds.split('\x1f');
                                                    const korean = fields[koreanIdx];
                                                    const english = fields[englishIdx];
                                                    
                                                    // now lets do this
                                                    if (i===1025) {
                                                        console.log(korean, '<=>', english);
                                                        await generateNuancedTranslation(korean);
                                                    }

                                                    // Another good candidate for the ol GPT
                                                    // yeah let's come back to this later, because 'to be', 'the', 'a', 'of' are tricky
                                                    for (const eng of splitEnglish(english)){
                                                            if (!(eng in postingList)){
                                                                    postingList[eng] = new Set();
                                                            }
                                                            postingList[eng].add(korean);
                                                    }
                                            }



                                            const sortedPostingList = Object.entries(postingList).sort((a,b)=>a[1].size-b[1].size);

                                            db.close();
                                            res();
                                    });
                            });
                    } else {
                            zipFile.readEntry();
                    }
            });
            zipFile.on('end', () => {});
    });
});

const NuanceMap = z.object({
        core_pick: z.string(),
        rationale: z.string(),
        // Collocations-first, 3–6 items (multilingual: "src" instead of "ko")
        sense_map: z.array(
                z.object({
                        src: z.string(),      // source-language collocation
                        en: z.string()        // best-fit rendering
                })
        ).min(3).max(6),
        // Candidate/near-synonyms list — at least 5, with rare EN equivalents + gloss
        near_synonyms: z.array(
                z.object({
                        src: z.string(),      // source-language near-synonym
                        en: z.string(),       // rare EN candidate (distinct from others)
                        gloss: z.string()     // 1-line nuance/gloss
                })
        ).min(5),
        // 2–4 compact examples
        mini_examples: z.array(
                z.object({
                        src: z.string(),
                        en: z.string()
                })
        ).min(2).max(4),
        why_special: z.string(),
        // Loanword detection (with Sino-Korean retained for KR focus)
        loanword: z.object({
                origin: z.enum(['native', 'sino-korean', 'loanword']),
                source_language: z.string().nullable(),
                source_form: z.string().nullable(),
                notes: z.string().nullable()
        }),
        // Final list economy: 3–5 unglossed headwords; first = core_pick
        // (exception: append " (loanword)" to first item if loanword)
        final_picks: z.array(z.string()).min(3).max(5)
});

const generateNuancedTranslation2 = async (korean) => {
        const response = await openai.chat.completions.parse({
                model: process.env.OPENAI_MODEL || 'gpt-5-mini-2025-08-07',
                messages: [
                        { role: 'system', content: SYSTEM_PROMPT },
                        { role: 'user', content: korean }
                ],
                response_format: zodResponseFormat(NuanceMap, 'NuanceMap'),
                // temperature: 0.2,
                // max_tokens: 800, 
                reasoning: { effort: "low" },
        });

        const msg = response.choices[0].message;
        let parsed = msg.parsed;           // validated against Zod schema

        console.log(parsed);

        return parsed;
};


/** 1) System prompt (stateless every call) */
const SYSTEM_PROMPT = `
You are a multilingual lexicographer that creates Anki card-ready English definitions optimized for disambiguation and memory.
Detect the input language automatically and proceed without clarification. Treat conversational speech, fiction, news, academic texts, and slang equally.

Rules (obey strictly):
1) Headword choice: select a specific, low-frequency English lemma capturing the word’s distinctive nuance. If a common English word is clearly the best translation and no other source-language near-synonym could plausibly match it, you may use it.
2) If a generic word is unavoidable, qualify it precisely (e.g., "thick (layered)", "cool (invigorating)").
3) Contrastive focus: clearly state what this word encodes that near-neighbors do not.
4) Collocations-first: provide 3–6 high-signal source-language collocations → best-fit EN renderings (use domain terms when apt).
5) Register & valence: highlight formality/tone/affect when relevant.
6) Polysemy: split only when meanings diverge significantly—avoid shallow or purely syntactic splits.
7) Candidate list BEFORE final picks: provide ≥5 near-synonyms/candidates as { src → en + gloss } with rare, discriminative English. All English items across near_synonyms and final_picks must be unique—no duplicates.
8) Final list economy: in "final_picks", output only 3–5 unglossed English headwords, starting with core_pick. If loanword.origin === "loanword", append " (loanword)" ONLY to the first item.
9) Loanword check: fill the loanword object (origin; if loanword, include source_language, source_form, and notes).
10) Tone: uncommon-but-natural English; concise and precise.
11) Call the provided function tool with a single argument object that matches its parameters exactly. Do not write prose.
`.trim();

/** 2) Function tool schema (strict) — This is the JSON you want back */
const tools = [
  {
    type: 'function',
    name: 'emit_nuance_map',
    description: 'Emit a complete nuance-first mapping for a source-language term as strict JSON.',
    parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          core_pick: { type: 'string', description: 'Chosen English headword.' },
          rationale: { type: 'string', description: 'One–two sentences justifying the core pick.' },
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
            description: 'Candidate list BEFORE final picks; rare EN equivalents with gloss.',
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
            description: '3–5 unglossed headwords; first = core_pick (append " (loanword)" iff loanword).',
            items: { type: 'string' }
          }
        },
        required: [
          'core_pick','rationale','sense_map','near_synonyms',
          'mini_examples','why_special','loanword','final_picks'
        ]
      }
  }
];

async function generateNuancedTranslation(term) {
  const completion = await openai.responses.create({
    model: 'gpt-5-2025-08-07',
    input: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: term },
    ],
    reasoning: { effort: "low" },
    tools,
    // Force exactly one call to our function tool; no parallel calls.
    tool_choice: { type: 'function', name: 'emit_nuance_map' },
    //tool_choice: { type: "function", function: { name: "emit_nuance_map" } },
    parallel_tool_calls: false
  });

  const functionCall = completion.output.find(item => 
    item.type === 'function_call' && item.name === 'emit_nuance_map'
  );
  
  const args = JSON.parse(functionCall.arguments);
  console.log(args);
  return args;
}


const splitEnglish = e => e.replace(/<\/?div>|<br>|to\ |be\ |\ the\ |\ a\ |[;()]/g, '') 
    .trim()
    .split(' ');

if (require.main === module) {
    gen();
}
