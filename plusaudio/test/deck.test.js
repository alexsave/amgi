'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  fieldChecksum,
  resolveFields,
  setOwnedSound,
  soundFilenames,
  spokenText,
  stripHtmlPreservingMedia,
} = require('../lib/deck');
const { isOwnedMediaName, mediaName } = require('../lib/audio-store');

// Expected values produced by Anki itself:
//   anki.utils.strip_html_media / anki.utils.field_checksum, anki 26.09.2.
// These are the columns Anki's own duplicate finder reads, so a divergence
// here is a corrupted collection, not a cosmetic difference.
const ANKI_CASES = [
  {
    field: '<div><b>안녕하십니까</b>? 9시 뉴스<b>입니다</b></div><div></div>',
    stripped: '안녕하십니까? 9시 뉴스입니다',
    csum: 3846690969,
  },
  {
    field: '<div>질문 <b>있습니까</b>?&nbsp;</div>',
    stripped: '질문 있습니까? ',
    csum: 2011365100,
  },
  {
    field: '[sound:1-1-13-1.mp3]<img src="paste-abc.jpg">',
    stripped: '[sound:1-1-13-1.mp3] paste-abc.jpg ',
    csum: 795728447,
  },
];

describe('field text', () => {
  for (const testCase of ANKI_CASES) {
    it(`matches Anki for ${JSON.stringify(testCase.field).slice(0, 40)}`, () => {
      assert.equal(stripHtmlPreservingMedia(testCase.field), testCase.stripped);
      assert.equal(fieldChecksum(testCase.field), testCase.csum);
    });
  }

  it('reads a field aloud without its markup or media', () => {
    assert.equal(
      spokenText('<div>가: <b>네</b>?&nbsp;</div><div>나: 네.</div>[sound:x.mp3]'),
      '가: 네? 나: 네.',
    );
    assert.equal(spokenText('<img src="only-a-picture.jpg">'), '');
    assert.equal(spokenText('a&amp;b'), 'a&b');
  });
});

describe('sound tags', () => {
  it('finds every tag in a field', () => {
    assert.deepEqual(soundFilenames('x[sound:a.mp3]y[sound:b.mp3]'), ['a.mp3', 'b.mp3']);
  });

  it('replaces only the tags this tool owns', () => {
    const clip = mediaName('hello', 'ko');
    const field = '[sound:author.mp3]<img src="p.jpg">[sound:old_gpt4o.mp3]';
    const updated = setOwnedSound(field, clip, isOwnedMediaName);
    assert.equal(updated, `[sound:author.mp3]<img src="p.jpg">[sound:${clip}]`);
  });

  it('collapses duplicate owned tags to one', () => {
    const field = '[sound:a_gpt4o.mp3][sound:b_gpt4o.mp3]';
    assert.equal(setOwnedSound(field, 'plusaudio-00000000000000000000.mp3', isOwnedMediaName),
      '[sound:plusaudio-00000000000000000000.mp3]');
  });

  it('appends when the field has no owned tag', () => {
    assert.equal(setOwnedSound('<img src="p.jpg">', 'c.mp3', () => true), '<img src="p.jpg">[sound:c.mp3]');
    assert.equal(setOwnedSound('', 'c.mp3', () => true), '[sound:c.mp3]');
  });
});

describe('media names', () => {
  it('derives the name from the text, so a re-run of unchanged text is a no-op', () => {
    assert.equal(mediaName('안녕', 'ko'), mediaName('안녕', 'ko'));
    assert.notEqual(mediaName('안녕', 'ko'), mediaName('안녕하세요', 'ko'));
    assert.notEqual(mediaName('안녕', 'ko'), mediaName('안녕', 'ja'));
    assert.match(mediaName('안녕', 'ko'), /^plusaudio-[0-9a-f]{20}\.mp3$/);
  });

  it('recognises its own clips and the ones the 2025 scripts wrote', () => {
    assert.ok(isOwnedMediaName(mediaName('x', 'ko')));
    assert.ok(isOwnedMediaName('안녕_gpt4o.mp3'));
    assert.ok(!isOwnedMediaName('1-1-13-1.mp3'));
    assert.ok(!isOwnedMediaName('paste-abc.jpg'));
  });
});

describe('field resolution', () => {
  const notetype = {
    id: 1,
    name: "Retro's sentences",
    sortFieldIndex: 2,
    fieldNames: ['Korean', 'Audio', 'Sort'],
  };

  it('finds the audio field and the text field by name', () => {
    assert.deepEqual(resolveFields(notetype), { textIndex: 0, audioIndex: 1 });
  });

  it('accepts explicit names and indexes', () => {
    assert.deepEqual(resolveFields(notetype, { textField: 'Sort', audioField: 'Audio' }), {
      textIndex: 2,
      audioIndex: 1,
    });
    assert.deepEqual(resolveFields(notetype, { textField: '2', audioField: '1' }), {
      textIndex: 2,
      audioIndex: 1,
    });
  });

  it('refuses to guess an audio field rather than overwrite content', () => {
    const cloze = { id: 2, name: 'Cloze', sortFieldIndex: 0, fieldNames: ['Text', 'Back Extra'] };
    assert.throws(() => resolveFields(cloze), /--audio-field/);
    assert.deepEqual(resolveFields(cloze, { audioField: 'Back Extra' }), {
      textIndex: 0,
      audioIndex: 1,
    });
  });

  it('rejects an unknown field name and an out-of-range index', () => {
    assert.throws(() => resolveFields(notetype, { audioField: 'Nope' }), /no field named/);
    assert.throws(() => resolveFields(notetype, { audioField: '7' }), /out of range/);
  });

  it('rejects reading and writing the same field', () => {
    assert.throws(
      () => resolveFields(notetype, { textField: 'Audio', audioField: 'Audio' }),
      /same field/,
    );
  });
});
