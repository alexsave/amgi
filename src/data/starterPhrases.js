// The starter deck's phrases: starterPhrases.tsv beside this file, the same ten concepts in every language
// amgi supports, index for index (server/amgi/starter.c says why they are parallel). Read here for scripts/build-starter-audio.js; the server reads the same file in C. The first line names
// each column by its language code; every line after it is one concept, one phrase per column.
// Tab-separated UTF-8, no quoting: a phrase never holds a tab or a line break.
import fs from 'node:fs';
import path from 'node:path';

export const STARTER_PHRASES_FILE = path.join(import.meta.dirname, 'starterPhrases.tsv');

/**
 * The phrases by language code, each a list in concept order, or null when the text is not a
 * whole table (no header, a line with too few or too many columns, an empty phrase).
 */
export function parseStarterPhrases(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length < 2) return null;
  const codes = lines[0].split('\t');
  if (codes.some((code) => !code) || new Set(codes).size !== codes.length) return null;
  const phrases = Object.fromEntries(codes.map((code) => [code, []]));
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    if (cells.length !== codes.length || cells.some((cell) => !cell)) return null;
    cells.forEach((cell, i) => phrases[codes[i]].push(cell));
  }
  return phrases;
}

/** The shipped phrases, or null when the file is missing or not a whole table. */
export function readStarterPhrases(file = STARTER_PHRASES_FILE) {
  try {
    return parseStarterPhrases(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
