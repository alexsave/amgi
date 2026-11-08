'use strict';

// The Gemini model's structured answer. The API's structured output is JSON
// text and nothing else (plusaudio/ANSWER_FORMAT.md records what was measured
// against the alternatives), so this one parse stays. The caller checks the
// value against its format (cardGeneration.ts, readStructured).

/** The answer's value, or why the text is not JSON. */
function parseModelAnswer(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, detail: `not JSON: "${text.slice(0, 80)}"` };
  }
}

module.exports = { parseModelAnswer };
