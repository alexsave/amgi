'use strict';

// Deciding which cards a new note needs - the "real subtlety" in adding a
// note, because it is the one piece of bookkeeping that cannot be read
// straight off a column: Anki does not store "this note has N cards", it
// derives N from whether each card type's front template renders anything
// given the note's non-empty fields (rslib/src/notetype/cardgen.rs,
// CardGenContext::is_nonempty / new_cards_required_normal, and
// rslib/src/template.rs, ParsedTemplate::renders_with_fields /
// template_is_empty). This module ports that check, not a full template
// renderer: it only needs to answer "would this produce any output", never
// "what output", so filters, HTML and conditionals-within-conditionals matter
// but the actual substitution of field text does not.
//
// Cloze note types use a different rule entirely (one card per distinct
// {{c<N>::...}} number across all fields, rslib/src/cloze.rs,
// cloze_number_in_fields) and are handled separately below. This module's
// cloze-number extraction is a plain regex rather than a port of cloze.rs's
// nested-cloze parser: nested clozes ({{c1::a {{c2::b}} c}}) are rare enough
// in real decks that matching Anki's behaviour on the common, non-nested case
// is the right amount of effort here, and it is called out again at the
// function that does it.

const OPEN_TAG = /\{\{([^{}]*)\}\}/;

/**
 * Tokenize a template's question (front) format string into text and
 * handlebar tokens, mirroring template.rs's `tokens`/`classify_handle`.
 * Legacy `<%= %>` syntax and `<!-- -->` HTML comments are not modelled
 * separately: neither can reference a field, so leaving them as inert text
 * (never matching the `{{...}}` pattern below) gives the same emptiness
 * answer as parsing them properly would.
 */
function tokenize(template) {
  const tokens = [];
  let rest = template;
  for (;;) {
    const match = OPEN_TAG.exec(rest);
    if (!match) {
      if (rest) tokens.push({ type: 'text' });
      break;
    }
    if (match.index > 0) tokens.push({ type: 'text' });
    const body = match[1].trim();
    if (body.startsWith('#')) {
      tokens.push({ type: 'open', key: body.slice(1).trim() });
    } else if (body.startsWith('^')) {
      tokens.push({ type: 'open-negated', key: body.slice(1).trim() });
    } else if (body.startsWith('/')) {
      tokens.push({ type: 'close', key: body.slice(1).trim() });
    } else {
      // A replacement's key is the part after the last ':' (filters are
      // written before the field name, e.g. {{furigana:Front}}); we don't
      // need to know which filters were applied, only which field decides
      // whether the tag can render.
      const parts = body.split(':');
      tokens.push({ type: 'replacement', key: parts[parts.length - 1].trim() });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return tokens;
}

/** Parse tokens into a tree of {type, key?, children?} nodes (template.rs, parse_inner). */
function parse(tokens) {
  let cursor = 0;

  function parseUntil(openKey) {
    const nodes = [];
    while (cursor < tokens.length) {
      const token = tokens[cursor];
      if (token.type === 'close') {
        if (openKey === undefined) {
          throw new Error(`{{/${token.key}}} has no matching {{#${token.key}}}`);
        }
        cursor += 1;
        return nodes;
      }
      cursor += 1;
      if (token.type === 'text') {
        nodes.push({ type: token.type });
      } else if (token.type === 'replacement') {
        nodes.push({ type: 'replacement', key: token.key });
      } else if (token.type === 'open' || token.type === 'open-negated') {
        nodes.push({ type: token.type, key: token.key, children: parseUntil(token.key) });
      }
    }
    if (openKey !== undefined) throw new Error(`{{#${openKey}}} was never closed`);
    return nodes;
  }

  return parseUntil(undefined);
}

/**
 * template_is_empty (template.rs), with check_negated always true - the
 * branch `renders_with_fields` (as opposed to the legacy
 * `renders_with_fields_for_reqs`) uses, and the one that matches what current
 * Anki does when generating cards for a newly added note.
 */
function nodesRenderNonEmpty(nonemptyFields, nodes) {
  for (const node of nodes) {
    if (node.type === 'text') continue;
    if (node.type === 'replacement') {
      if (nonemptyFields.has(node.key)) return true;
    } else if (node.type === 'open') {
      if (nonemptyFields.has(node.key) && nodesRenderNonEmpty(nonemptyFields, node.children)) return true;
    } else if (node.type === 'open-negated') {
      if (nonemptyFields.has(node.key)) continue;
      if (nodesRenderNonEmpty(nonemptyFields, node.children)) return true;
    }
  }
  return false;
}

/**
 * Would this template's front side render any output given a note whose
 * non-empty field (and special-field) names are `nonemptyFields`?
 *
 * A template that fails to parse cannot be generated (cardgen.rs,
 * CardGenContext::is_nonempty: "template failed to parse; card can not be
 * generated"), so parse errors are swallowed into `false` here rather than
 * thrown - the caller should not fail to add a note because one of its
 * note type's templates has a syntax error that predates this tool.
 */
function templateRendersNonEmpty(questionFormat, nonemptyFields) {
  try {
    return nodesRenderNonEmpty(nonemptyFields, parse(tokenize(questionFormat)));
  } catch {
    return false;
  }
}

// New entries must mirror notetype/mod.rs SPECIAL_FIELDS. "FrontSide" is
// deliberately excluded - it is never treated as non-empty for card
// generation purposes, only Tags (when the note actually has any) and the
// rest (always available placeholders) are added on top of the note's own
// field names before checking each template.
const ALWAYS_NONEMPTY_SPECIAL_FIELDS = ['Card', 'CardFlag', 'Deck', 'Subdeck', 'Type', 'CardID'];

/**
 * The set of field/placeholder names a template's {{Field}} or {{#Field}} can
 * see as "present", for a normal (non-cloze) note type (cardgen.rs,
 * new_cards_required_normal).
 */
function nonemptyFieldsFor(fieldNames, fieldValues, tags) {
  const nonempty = new Set();
  fieldNames.forEach((name, index) => {
    if ((fieldValues[index] ?? '').length > 0) nonempty.add(name);
  });
  const ownFieldNames = new Set(fieldNames);
  for (const special of ALWAYS_NONEMPTY_SPECIAL_FIELDS) {
    if (!ownFieldNames.has(special)) nonempty.add(special);
  }
  if (!ownFieldNames.has('Tags') && tags.length > 0) nonempty.add('Tags');
  return nonempty;
}

/**
 * Cloze numbers referenced anywhere in a note's fields, e.g. {{c1::...}} and
 * {{c2::...::hint}} both contribute their number.
 *
 * Simplified from cloze.rs's cloze_number_in_fields: this does not parse
 * nested clozes ({{c1::outer {{c2::inner}} text}}), which real decks
 * essentially never contain outside of Anki's own test suite. A field with
 * one is still handled safely - the outer number is still found, since the
 * regex does not require the closing `}}` to be the very next one - it just
 * cannot see a nested number if the inner `::` is missing, an even rarer case.
 */
function clozeNumbersInFields(fieldValues) {
  const numbers = new Set();
  const pattern = /\{\{c(\d+)::/g;
  for (const value of fieldValues) {
    for (const match of String(value ?? '').matchAll(pattern)) {
      const n = Number(match[1]);
      if (n > 0) numbers.add(Math.min(n, 500));
    }
  }
  return numbers;
}

/**
 * Which card ordinals (0-based) a new note needs, and the CardTemplateConfig
 * ordinal each one is generated from - the same number for a cloze note type,
 * since it has exactly one template shared by every cloze card.
 *
 * Ports CardGenContext::new_cards_required with `existing = []` (a brand new
 * note has no cards yet) and `ensure_not_empty = true`, which is the constant
 * every caller of generate_cards_for_note passes (cardgen.rs).
 */
function ordinalsForNewNote({ kind, templates, fieldNames, fieldValues, tags }) {
  if (kind === 'cloze') {
    const numbers = [...clozeNumbersInFields(fieldValues)].sort((a, b) => a - b);
    const ords = numbers.map((n) => n - 1);
    return ords.length > 0 ? ords : [0];
  }

  const nonempty = nonemptyFieldsFor(fieldNames, fieldValues, tags);
  const ords = templates
    .map((template, ord) => ({ ord, renders: templateRendersNonEmpty(template.questionFormat, nonempty) }))
    .filter((entry) => entry.renders)
    .map((entry) => entry.ord);
  return ords.length > 0 ? ords : [0];
}

module.exports = {
  clozeNumbersInFields,
  nodesRenderNonEmpty,
  nonemptyFieldsFor,
  ordinalsForNewNote,
  parse,
  templateRendersNonEmpty,
  tokenize,
};
