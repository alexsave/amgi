'use strict';

// The layout plusaudio/generate-card-text.js prints a card in on stdout, and
// its one reader (src/server/anki/cardText.js). Both ends require this file,
// so the script and the server cannot drift apart on it.
//
// A card side holds whatever the model wrote, newlines and quotes included,
// so nothing is escaped: every value is its UTF-8 byte length, then its
// bytes. A header line, then the three fields in this fixed order, each as
// `<name> <byte length>\n<bytes>\n`:
//
//   amgi-card-text 1
//   front_text 21
//   Where is the station?
//   back_text 20
//   역이 어디예요?
//   spoken_reading 0
//
// A person running the script can still read it. The reader is strict: a
// wrong header, a field out of order or missing, a length that does not fit
// its bytes, or anything after the last field is an error, never a guess.

const HEADER = 'amgi-card-text 1';
const FIELDS = Object.freeze(['front_text', 'back_text', 'spoken_reading']);
const NEWLINE = 0x0a;

/** The bytes a card is printed as. Every field must be a string (a missing one is empty). */
function writeCardText(card) {
  const parts = [Buffer.from(`${HEADER}\n`)];
  for (const name of FIELDS) {
    const value = card[name] ?? '';
    if (typeof value !== 'string') throw new TypeError(`card text: ${name} is not a string`);
    const bytes = Buffer.from(value, 'utf8');
    parts.push(Buffer.from(`${name} ${bytes.length}\n`), bytes, Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

/** The card in `output` (the bytes, or the string they decode to). Throws unless it is exactly the layout. */
function readCardText(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(String(output), 'utf8');
  let at = 0;
  const line = () => {
    const end = bytes.indexOf(NEWLINE, at);
    if (end < 0) throw new Error('card text: the output ends in the middle of a line');
    const text = bytes.toString('utf8', at, end);
    at = end + 1;
    return text;
  };
  if (line() !== HEADER) throw new Error(`card text: the output does not start with "${HEADER}"`);
  const card = {};
  for (const name of FIELDS) {
    const head = /^([a-z_]+) (0|[1-9][0-9]{0,8})$/.exec(line());
    if (!head || head[1] !== name) throw new Error(`card text: ${name} was expected next`);
    const length = Number(head[2]);
    if (at + length >= bytes.length || bytes[at + length] !== NEWLINE) {
      throw new Error(`card text: ${name} is not ${length} bytes followed by a line break`);
    }
    card[name] = bytes.toString('utf8', at, at + length);
    at += length + 1;
  }
  if (at !== bytes.length) throw new Error('card text: there is more output after the last field');
  return card;
}

module.exports = { FIELDS, HEADER, readCardText, writeCardText };
