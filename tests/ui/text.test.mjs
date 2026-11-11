// ui/src/text.c and fields.c against what the JS they replaced answered, as text-expected.mjs froze it:
// ankiFields.js, gone with the React app, and lyricsParse.js, gone once C served every caller. Run
// ui/build.sh first (it builds ui/out/text_dump).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { sandboxEnv } from '../repo/sandbox-home.cjs';
import { fileURLToPath } from 'node:url';
import { DEDUPE, GUESSES, HAS_AUDIO, PASTE_LINES, STRIP_HTML } from './text-expected.mjs';

const dump = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'out', 'text_dump');
const enc = new TextEncoder(), dec = new TextDecoder();
// Every (function, input) through the C at once; the answers in order.
function c(calls) {
  const parts = calls.flatMap(([fn, s]) => {
    const b = enc.encode(s);
    const head = Buffer.alloc(8);
    head.writeUInt32LE(fn, 0);
    head.writeUInt32LE(b.length, 4);
    return [head, Buffer.from(b)];
  });
  const out = execFileSync(dump, { env: sandboxEnv(), input: Buffer.concat(parts) });
  const answers = [];
  for (let at = 0; at < out.length;) {
    const n = out.readUInt32LE(at);
    answers.push(dec.decode(out.subarray(at + 4, at + 4 + n)));
    at += 4 + n;
  }
  return answers;
}
// CardList.js's textIn after the field is found, and its audio regex.
const stripTags = (s) => s.replace(/<[^>]*>/g, '').trim();
const AUDIO_SRC = /<audio[^>]*\ssrc\s*=\s*["']([^"']+)["']/i;
const audioSrc = (s) => AUDIO_SRC.exec(s)?.[1] || '';

const SAMPLES = [
  '', ' ', 'plain', '  역이 어디예요?  ', '　全角　', ' nbsp ', '﻿bom', 'tab\tand\nnew line',
  '<b>bold</b> text', 'a<br>b', '<audio src="x.wav"></audio>', '<AUDIO controls SRC = \'y.mp3\'>', 'x < y > z',
  'unclosed <tag', '&nbsp;&nbsp;two', 'a&nbsp;b', '<audio src="a.wav" data-x src="b.wav">', '<audio src="">',
  '<audio data-src="no.wav">', '<audiosrc="no">', '[sound:clip.mp3]', '[sound:unclosed', 'Hello, world!',
  'Wait...', '그래요?!', '「引用」。', 'Done…', '"quoted"', '‘single’', '...', '!!!', ' , ', 'a  b   c', 'mixed line',
  '<audio\tsrc="tab.wav">', '<div><audio src="first.wav"></audio><audio src="second.wav"></audio></div>',
];

test('trim, strip_html, strip_tags, audio_src, has_audio_ref and dedupe_key answer what the JS did', () => {
  const fns = [
    [0, (s) => s.trim()], [1, (s, i) => STRIP_HTML[i]], [2, stripTags], [3, audioSrc],
    [4, (s, i) => String(HAS_AUDIO[i])], [5, (s, i) => DEDUPE[i]],
  ];
  assert.equal(DEDUPE.length, SAMPLES.length, 'a frozen answer for every sample');
  const calls = fns.flatMap(([fn]) => SAMPLES.map((s) => [fn, s]));
  const got = c(calls);
  const want = fns.flatMap(([, f]) => SAMPLES.map((s, i) => f(s, i)));
  calls.forEach(([fn, s], i) => assert.equal(got[i], want[i], `function ${fn} on ${JSON.stringify(s)}`));
});

test('guess_fields picks the fields guessFields does', () => {
  const types = [
    { fieldNames: ['Cue', 'CueAudio', 'Target', 'TargetAudio', 'Language', 'Notes'], sortFieldIndex: 0 },
    { fieldNames: ['Front', 'Back'], sortFieldIndex: 0 },
    { fieldNames: ['Korean', 'English', 'Audio'], sortFieldIndex: 1 },
    { fieldNames: ['Expression', 'Meaning', 'Sound', 'Pronunciation'], sortFieldIndex: 0 },
    { fieldNames: ['A', 'B', 'C'], sortFieldIndex: 2 },
    { fieldNames: ['Audio', 'Sound'], sortFieldIndex: 0 },
    { fieldNames: ['Word', 'WordAudio', 'Sentence', 'SentenceAudio'], sortFieldIndex: 0 },
    { fieldNames: ['단어', '뜻'], sortFieldIndex: 1 },
    { fieldNames: ['TargetAudio', 'Target', 'CueAudio', 'Cue'], sortFieldIndex: 3 }, // the stem decides, not the order
    { fieldNames: ['Field 0', 'Field 1'] },
    { fieldNames: [] },
  ];
  const calls = types.map((t) => [6, t.fieldNames.join('\x1f') + (t.sortFieldIndex === undefined ? '' : `\x1e${t.sortFieldIndex}`)]);
  const got = c(calls);
  types.forEach((t, i) => assert.equal(got[i], GUESSES[i], t.fieldNames.join(', ')));
});

test('paste_lines makes the lines parseLyricsPaste made', () => {
  const pastes = [
    '', 'one line', 'a\nb\r\nc\rd', '  spaced  \n\n\t\n', '[Chorus]\nla la\n[Verse 2]\nla la.\nLa la',
    'I said [laughs] okay\n[a]b]\n[]\n[ ]', '역이 어디예요?\n역이 어디예요\n역이  어디예요?!', '...\n!!!\n...',
    'trailing\n', '\r\n\r\n', 'Hello, world\nhello, world\nHello world', '「引用」。\n「引用」',
    '  first line  \n\n  second line\n   \n', 'same line\nother line\nsame line\nsame line',
    'chorus line\nchorus line,\nchorus line.', 'Love\nlove', '[Verse 1]\nfirst line\n[Chorus]\nsecond line', 'c\na\nb\na',
    '[Verse 1]\n오늘도 걷는다 나는\n아무 말 없이\n\n[Chorus]\n사랑해요 사랑해요\n사랑해요 사랑해요,\n[Chorus]\n사랑해요 사랑해요',
  ];
  assert.equal(PASTE_LINES.length, pastes.length, 'a frozen answer for every paste');
  const got = c(pastes.map((p) => [7, p]));
  pastes.forEach((p, i) => {
    assert.equal(got[i], PASTE_LINES[i], JSON.stringify(p));
  });
});
