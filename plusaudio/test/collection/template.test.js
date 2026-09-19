'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  clozeNumbersInFields,
  nonemptyFieldsFor,
  ordinalsForNewNote,
  templateRendersNonEmpty,
} = require('../../lib/collection/template');

test('templateRendersNonEmpty: a plain field reference', () => {
  assert.equal(templateRendersNonEmpty('{{Front}}', new Set(['Front'])), true);
  assert.equal(templateRendersNonEmpty('{{Front}}', new Set(['Back'])), false);
});

test('templateRendersNonEmpty: text around a tag does not count on its own', () => {
  assert.equal(templateRendersNonEmpty('just text, no field', new Set(['Front'])), false);
});

test('templateRendersNonEmpty: a conditional only renders if its key is present and its body does', () => {
  const tmpl = '{{#Reverse}}{{Back}}{{/Reverse}}';
  assert.equal(templateRendersNonEmpty(tmpl, new Set(['Reverse', 'Back'])), true);
  assert.equal(templateRendersNonEmpty(tmpl, new Set(['Back'])), false, 'Reverse not present');
  assert.equal(templateRendersNonEmpty(tmpl, new Set(['Reverse'])), false, 'body has nothing to render');
});

test('templateRendersNonEmpty: a negated conditional renders its body when the key is absent', () => {
  const tmpl = '{{^Hint}}no hint: {{Front}}{{/Hint}}';
  assert.equal(templateRendersNonEmpty(tmpl, new Set(['Front'])), true);
  assert.equal(templateRendersNonEmpty(tmpl, new Set(['Front', 'Hint'])), false);
});

test('templateRendersNonEmpty: a filtered replacement still keys off the field name', () => {
  assert.equal(templateRendersNonEmpty('{{furigana:Front}}', new Set(['Front'])), true);
  assert.equal(templateRendersNonEmpty('{{furigana:Front}}', new Set(['Back'])), false);
});

test('templateRendersNonEmpty: a template that fails to parse cannot be generated', () => {
  assert.equal(templateRendersNonEmpty('{{#Unclosed}}{{Front}}', new Set(['Unclosed', 'Front'])), false);
});

test('nonemptyFieldsFor: always-available special fields, Tags only when the note has any', () => {
  const names = ['Front', 'Back'];
  const withoutTags = nonemptyFieldsFor(names, ['x', ''], []);
  assert.equal(withoutTags.has('Card'), true);
  assert.equal(withoutTags.has('Tags'), false);
  assert.equal(withoutTags.has('FrontSide'), false, 'FrontSide is never synthesised');
  const withTags = nonemptyFieldsFor(names, ['x', ''], ['japanese']);
  assert.equal(withTags.has('Tags'), true);
});

test('ordinalsForNewNote: Basic-shaped note type generates its one card when Front has text', () => {
  const ords = ordinalsForNewNote({
    kind: 'normal',
    templates: [{ ord: 0, questionFormat: '{{Front}}' }],
    fieldNames: ['Front', 'Back'],
    fieldValues: ['hello', 'world'],
    tags: [],
  });
  assert.deepEqual(ords, [0]);
});

test('ordinalsForNewNote: optional-reversed-card type only generates card 2 when the toggle field is set', () => {
  const templates = [
    { ord: 0, questionFormat: '{{Front}}' },
    { ord: 1, questionFormat: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}' },
  ];
  const fieldNames = ['Front', 'Back', 'Add Reverse'];
  assert.deepEqual(
    ordinalsForNewNote({ kind: 'normal', templates, fieldNames, fieldValues: ['f', 'b', ''], tags: [] }),
    [0],
  );
  assert.deepEqual(
    ordinalsForNewNote({ kind: 'normal', templates, fieldNames, fieldValues: ['f', 'b', 'y'], tags: [] }),
    [0, 1],
  );
});

test('ordinalsForNewNote: a note with no field a template can use still gets card 0 (ensure_not_empty)', () => {
  const ords = ordinalsForNewNote({
    kind: 'normal',
    templates: [{ ord: 0, questionFormat: '{{Front}}' }],
    fieldNames: ['Front', 'Back'],
    fieldValues: ['', ''],
    tags: [],
  });
  assert.deepEqual(ords, [0]);
});

test('clozeNumbersInFields: distinct numbers across fields, in order', () => {
  const numbers = clozeNumbersInFields(['{{c2::b}} and {{c1::a}}', 'plain', '{{c1::again}}']);
  assert.deepEqual([...numbers].sort((a, b) => a - b), [1, 2]);
});

test('ordinalsForNewNote: cloze note type generates one card per cloze number, zero-based', () => {
  const ords = ordinalsForNewNote({
    kind: 'cloze',
    templates: [{ ord: 0, questionFormat: '{{cloze:Text}}' }],
    fieldNames: ['Text', 'Back Extra'],
    fieldValues: ['{{c1::foo}} and {{c2::bar}}', ''],
    tags: [],
  });
  assert.deepEqual(ords, [0, 1]);
});

test('ordinalsForNewNote: a cloze note with no cloze markup still gets card 0', () => {
  const ords = ordinalsForNewNote({
    kind: 'cloze',
    templates: [{ ord: 0, questionFormat: '{{cloze:Text}}' }],
    fieldNames: ['Text', 'Back Extra'],
    fieldValues: ['no cloze here', ''],
    tags: [],
  });
  assert.deepEqual(ords, [0]);
});
