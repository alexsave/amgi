// SCAFFOLDING, removed at L4 with plusaudio/lib/cardGeneration/cardText.ts: runs the TypeScript card
// policy once over the golden inputs and writes the expected outputs the golden tests hold the C to.
//
//   node test/parity/golden/make-golden-cards.mjs
//
// korean-inputs.txt (one text per line) -> korean-expected.tsv: text, koreanPronunciation(text),
//   normalizeForComparison(text, 'ko').
// judge-inputs.tsv (language, text, transcript, reading) -> judge-expected.tsv: the four inputs, then
//   spokenForm(text), normalizeForComparison of the transcript and of the spoken form, readingIsAmbiguous,
//   and the decision cardGeneration.ts's generateCardAudio takes before any judge is asked: "accept"
//   when the transcript matches and no reading must be heard, else "judge".
import fs from 'node:fs';
import path from 'node:path';
import {
  koreanPronunciation,
  normalizeForComparison,
  readingIsAmbiguous,
  spokenForm,
} from '../../../plusaudio/lib/cardGeneration/cardText.ts';

const here = import.meta.dirname;
const lines = (file) => fs.readFileSync(path.join(here, file), 'utf8').split('\n').filter((l) => l !== '');

const korean = lines('korean-inputs.txt').map((text) => [text, koreanPronunciation(text), normalizeForComparison(text, 'ko')]);
fs.writeFileSync(path.join(here, 'korean-expected.tsv'), `${korean.map((r) => r.join('\t')).join('\n')}\n`);

const judge = lines('judge-inputs.tsv').map((line) => {
  const [language, text, transcript, reading = ''] = line.split('\t');
  const spoken = spokenForm(text);
  const heard = normalizeForComparison(transcript, language);
  const said = normalizeForComparison(spoken, language);
  const ambiguous = readingIsAmbiguous(language);
  const mustHear = ambiguous && reading.trim() !== '';
  const decision = heard === said && !mustHear ? 'accept' : 'judge';
  return [language, text, transcript, reading, spoken, heard, said, ambiguous ? '1' : '0', decision];
});
fs.writeFileSync(path.join(here, 'judge-expected.tsv'), `${judge.map((r) => r.join('\t')).join('\n')}\n`);
console.log(`korean ${korean.length}, judge ${judge.length}`);
