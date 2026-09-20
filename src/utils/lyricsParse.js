// Turning a pasted block of text (typically song lyrics) into the set of
// unique lines that should each become one card - the parsing half of the
// bulk-add-from-paste screen (see BulkAddForm.js). Pure and framework-free
// on purpose: the same normalization has to run identically on the client
// (deciding what the preview shows) and be trusted as the source of truth
// for what "the same line" means when checking against a deck's existing
// notes, so there is exactly one place this policy is written down.
//
// DEDUPE POLICY, spelled out because "dedupe" hides a real decision:
//
//  - The identity key used for matching is "trim, collapse any run of
//    internal whitespace to one space, drop a trailing run of punctuation".
//    A chorus that repeats with a stray trailing comma, an extra space from
//    a copy-paste, or one repeat ending with a period and another without,
//    is still the same spoken line to a learner - producing two
//    near-identical cards for it would be a bug, not a feature.
//  - Case is NEVER folded for the comparison. A model that lowercases before
//    comparing would be wrong for the very scripts a case-insensitive match
//    is meant to help with least: Hangul, Hiragana/Katakana/Han, Cyrillic,
//    Arabic, Devanagari and Thai have no case distinction at all, so folding
//    case buys those scripts nothing, while for a Latin-script line ("I" vs
//    "i", a proper noun vs the same word used generically) it can silently
//    merge two lines that are not actually interchangeable. Keeping case
//    exact costs the case-insensitive scripts nothing and protects the rest.
//  - Leading punctuation and internal casing are left alone entirely - only
//    the trailing run is touched, because that is specifically where a
//    transcription's stray comma or period ends up, not in the middle of a
//    line or at its start.
//
// This is deliberately a lighter touch than
// plusaudio/lib/cardGeneration/cardText.ts's normalizeForComparison (which
// lowercases and strips ALL punctuation and whitespace for a lenient
// transcription check): that function exists to compare a spoken-audio
// transcript against card text, where case and internal punctuation genuinely
// do not matter. Deduping a person's own pasted lines against each other is a
// different, stricter job - it must never treat two lines a learner would
// consider different as duplicates - so it gets its own, narrower rule
// instead of reusing that one.

const TRAILING_PUNCTUATION_RE = /[\s,.!?;:、。！？，；：…"'“”‘’]+$/u;

/**
 * The key two lines are compared by - see the module docstring for the
 * policy. Falls back to the trimmed line itself when stripping trailing
 * punctuation consumes the *entire* line (a line that is only punctuation,
 * e.g. "..." or "!!!", or a genuinely blank field on an existing note):
 * without that fallback, every such line normalizes to the same empty
 * string, which would make two lines a learner would clearly consider
 * different - "..." and "!!!" - collide as "the same line", the exact thing
 * this policy exists to prevent. Falling back to the untouched text keeps
 * the real, common case (trailing comma/period variants of real text) fully
 * intact, since that case never reduces to an empty string in the first
 * place.
 */
export function normalizeForDedupe(line) {
  const trimmed = (line || '').trim().replace(/\s+/g, ' ');
  return trimmed.replace(TRAILING_PUNCTUATION_RE, '') || trimmed;
}

// A line that is ENTIRELY one bracketed token, e.g. "[Chorus]" or
// "[Verse 2]" (whitespace around it tolerated) - lyrics' own convention for
// a structural marker, not a line anyone sings. A line that merely contains
// brackets ("I said [laughs] okay") is not a section marker and is never
// touched by this.
const SECTION_MARKER_RE = /^\[[^[\]]+\]$/;

export function isSectionMarker(line) {
  return SECTION_MARKER_RE.test((line || '').trim());
}

/**
 * Parse a pasted block of text into the unique candidate lines it should
 * become cards for, plus enough counts to explain to the person what
 * happened to the rest of what they pasted before anything is written.
 *
 * @param {string} rawText
 * @param {{skipSectionMarkers?: boolean}} [options]
 * @returns {{
 *   lines: Array<{text: string, key: string, occurrences: number, lineNumber: number}>,
 *   totalLines: number,
 *   blankCount: number,
 *   sectionMarkerCount: number,
 *   candidateCount: number,
 *   pasteDuplicateCount: number,
 * }}
 */
export function parseLyricsPaste(rawText, { skipSectionMarkers = true } = {}) {
  const rawLines = (rawText || '').split(/\r\n|\r|\n/);
  let blankCount = 0;
  let sectionMarkerCount = 0;
  let candidateCount = 0;
  const keyIndex = new Map();
  const lines = [];

  rawLines.forEach((raw, i) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      blankCount += 1;
      return;
    }
    if (skipSectionMarkers && isSectionMarker(trimmed)) {
      sectionMarkerCount += 1;
      return;
    }
    candidateCount += 1;
    const key = normalizeForDedupe(trimmed);
    const existingIndex = keyIndex.get(key);
    if (existingIndex !== undefined) {
      lines[existingIndex].occurrences += 1;
      return;
    }
    keyIndex.set(key, lines.length);
    lines.push({ text: trimmed, key, occurrences: 1, lineNumber: i + 1 });
  });

  return {
    lines,
    totalLines: rawLines.length,
    blankCount,
    sectionMarkerCount,
    candidateCount,
    pasteDuplicateCount: candidateCount - lines.length,
  };
}

/** A Set of dedupe keys for values already in the deck - what parsed lines get checked against next. */
export function existingKeySet(existingValues) {
  return new Set((existingValues || []).map((value) => normalizeForDedupe(value)));
}
