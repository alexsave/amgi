// The collection-parity runner's command protocol: how test/parity/collection.test.mjs drives an
// implementation of the collection core over its stdin and stdout, one line per command: the C
// core's server/build/collection_cli speaks it (the Node implementation it was first written for
// was removed at L4).
//
// A line is tokens separated by one space. A token is:
//   text     percent-encoded UTF-8 (every byte but A-Z a-z 0-9 - _ .), "~" for the empty string
//   absent   "!" (a JS undefined: an optional argument not given, a result with no value)
//   number   decimal, as JS writes it
//   list     "[" items "," ... "]", each item a token; "[]" is the empty list
// A record inside a list (a note type's templates, say) is one text token holding its own line.
//
// Commands, and what each answers (the answer's first token is "ok" or "err"):
//   open <collection path>                           ok
//   status                                           ok <status> <schemaVersion|!>
//   listDecks                                        ok <n>, then n lines: <id> <name>
//   countNotesInDeck <deck>                          ok <count>
//   listNotetypes                                    ok <n>, then n lines:
//                                                      <id> <name> <kind> <sortFieldIndex> [fieldNames] [templates]
//                                                      a template: "<ord> <name> <questionFormat> <answerFormat>"
//   listNotesInDeck <deck> <offset> <limit>          ok <offset> <limit> <hasMore 0|1> <n>, then n lines:
//                                                      <id> <notetypeId> [fields] [tags]
//   existingFieldValues <deck> <notetype> <field>    ok [values]
//   createDeck <name>                                ok <id> <name> <created 0|1>
//   renameDeck <deck> <name>                         ok <id> <name> <childrenRenamed>
//   deckRemovalSummary <deck>                        ok <id> <name> <subdecks> <cards> <notes>
//   removeDeck <deck>                                ok <id> <name> <decks> <cards> <notes>
//   addNote <note>                                   ok <noteId> <guid> [cardIds] <warning|!>
//     a note: <deckId> <notetypeId> [fields] [tags] <language|!> <learningFieldIndex|!>
//   addNotesBulk <n>, then n lines of <note>         ok <n>, then n lines: ok <noteId> <guid> [cardIds] <warning|!>
//                                                      or err <message>
//   updateNote <note> [fields] <language|!> <learningFieldIndex|!>
//                                                    ok <warning|!>
//   removeNote <note>                                ok <noteId> <cardsRemoved>
//   hasMedia <name>                                  ok <0|1>
//   readMedia <name>                                 ok <hex bytes|!>
//   addMedia <name> <hex bytes>                      ok <stored name>
//   createNotetype <name> [fields] [templates] <css> [requirements] [media]
//     a template: "<name> <front> <back>"; a requirement: "<ord> <kind> [field ords]"; a media
//     file: "<name> <hex bytes>"
//                                                    ok <created 0|1> <notetypeId|!> <reason|!>
//   parallel <n>, then n command lines               the n answers, in order: the commands run at
//                                                      once (the C CLI on n threads), the way
//                                                      concurrent requests reach one server
//   quit
// A command that fails answers: err <kind> <message>, where kind is the collection's state
// (locked, not-found, unsupported-schema), an HTTP status the error carries (404, 400), or
// "error".

const SAFE = /^[A-Za-z0-9\-_.]$/;

/** A string as one text token. */
export function enc(value) {
  if (value === undefined || value === null) return '!';
  const s = String(value);
  if (s === '') return '~';
  let out = '';
  for (const byte of Buffer.from(s, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += byte < 0x80 && SAFE.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** A text token back to its string; "!" is undefined. */
export function dec(token) {
  if (token === '!') return undefined;
  if (token === '~') return '';
  const bytes = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] === '%') {
      bytes.push(Number.parseInt(token.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(token.charCodeAt(i));
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A list of already-made tokens as one list token. */
export function list(tokens) {
  return `[${tokens.join(',')}]`;
}
export const strs = (values) => list(values.map(enc));
export const nums = (values) => list(values.map((v) => String(v)));

/** A list token back to its item tokens. */
export function items(token) {
  if (!token.startsWith('[') || !token.endsWith(']')) throw new Error(`not a list: ${token}`);
  const inner = token.slice(1, -1);
  return inner === '' ? [] : inner.split(',');
}

export const num = (token) => (token === '!' ? undefined : Number(token));
export const hex = (bytes) => (bytes === null || bytes === undefined ? '!' : Buffer.from(bytes).toString('hex') || '~');
export const unhex = (token) => (token === '!' ? null : Buffer.from(token === '~' ? '' : token, 'hex'));

/** A note (q_note's fields) as its tokens. */
export function noteTokens(note) {
  return [
    String(note.deckId), String(note.notetypeId), strs(note.fields), strs(note.tags ?? []),
    enc(note.language), note.learningFieldIndex === undefined ? '!' : String(note.learningFieldIndex),
  ].join(' ');
}

/** Tokens of a note, back to the object addNote takes. */
export function noteOf(tokens) {
  const [deckId, notetypeId, fields, tags, language, lfi] = tokens;
  const note = {
    deckId: Number(deckId), notetypeId: Number(notetypeId), fields: items(fields).map(dec), tags: items(tags).map(dec),
  };
  if (language !== '!') note.language = dec(language);
  if (lfi !== '!') note.learningFieldIndex = Number(lfi);
  return note;
}
