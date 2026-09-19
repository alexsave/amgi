'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  audioReferences,
  fieldChecksum,
  renderAudioReference,
  resolveFields,
  setOwnedAudio,
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
  {
    field: '<audio src="plusaudio-abc.mp3"></audio><img src="paste-abc.jpg">',
    stripped: ' plusaudio-abc.mp3  paste-abc.jpg ',
    csum: 1074455562,
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

describe('clip references', () => {
  it('finds every reference in a field, in either form, in order', () => {
    assert.deepEqual(
      audioReferences('x[sound:a.mp3]y<audio src="b.mp3"></audio>').map((r) => [r.name, r.form]),
      [
        ['a.mp3', 'sound'],
        ['b.mp3', 'html'],
      ],
    );
  });

  it('reads an <audio> reference however it is written', () => {
    const names = (field) => audioReferences(field).map((r) => r.name);
    assert.deepEqual(names("<audio src='b.mp3'>"), ['b.mp3']);
    assert.deepEqual(names('<audio controls src=b.mp3 class="x">'), ['b.mp3']);
    assert.deepEqual(names('<AUDIO SRC="b.mp3"></AUDIO>'), ['b.mp3']);
    // Anki decodes entities in a src before looking the file up, so we must too.
    assert.deepEqual(names('<audio src="a&amp;b.mp3"></audio>'), ['a&b.mp3']);
  });

  it('replaces only the references this tool owns', () => {
    const clip = mediaName('hello', 'ko');
    const field = '[sound:author.mp3]<img src="p.jpg">[sound:old_gpt4o.mp3]';
    const updated = setOwnedAudio(field, clip, isOwnedMediaName);
    assert.equal(updated, `[sound:author.mp3]<img src="p.jpg">[sound:${clip}]`);
  });

  it('writes an HTML media reference when asked for one', () => {
    const clip = mediaName('hello', 'ko');
    assert.equal(
      setOwnedAudio('[sound:author.mp3]', clip, isOwnedMediaName, 'html'),
      `[sound:author.mp3]<audio src="${clip}"></audio>`,
    );
    assert.equal(renderAudioReference('c.mp3', 'html'), '<audio src="c.mp3"></audio>');
    assert.equal(renderAudioReference('c.mp3', 'sound'), '[sound:c.mp3]');
  });

  it('converts between the two forms in place rather than adding a second reference', () => {
    const clip = mediaName('hello', 'ko');
    const sound = `<img src="p.jpg">[sound:${clip}]after`;
    const html = setOwnedAudio(sound, clip, isOwnedMediaName, 'html');
    assert.equal(html, `<img src="p.jpg"><audio src="${clip}"></audio>after`);
    assert.equal(setOwnedAudio(html, clip, isOwnedMediaName, 'sound'), sound);
    assert.equal(audioReferences(html).filter((r) => isOwnedMediaName(r.name)).length, 1);
  });

  it('collapses duplicate owned references to one, across both forms', () => {
    const field = '[sound:a_gpt4o.mp3]<audio src="b_gpt4o.mp3"></audio>';
    assert.equal(
      setOwnedAudio(field, 'plusaudio-00000000000000000000.mp3', isOwnedMediaName),
      '[sound:plusaudio-00000000000000000000.mp3]',
    );
    assert.equal(
      setOwnedAudio(field, 'plusaudio-00000000000000000000.mp3', isOwnedMediaName, 'html'),
      '<audio src="plusaudio-00000000000000000000.mp3"></audio>',
    );
  });

  it('writes the reference the anki/ card template actually reads', () => {
    // The template is the only consumer of the html form, so the shape it
    // looks for is the specification. If it changes, this has to change with
    // it rather than the two drifting into separate conventions.
    const loop = fs.readFileSync(path.join(__dirname, '..', '..', 'anki', 'src', 'anki-loop.js'), 'utf8');
    const selector = loop.match(/slot\.querySelector\('([^']+)'\)/)?.[1];
    assert.equal(selector, 'audio[src]', 'anki/src/anki-loop.js no longer looks for an <audio src>');

    const [, tag, attribute] = selector.match(/^(\w+)\[(\w+)\]$/);
    assert.equal(renderAudioReference('clip.mp3', 'html'), `<${tag} ${attribute}="clip.mp3"></${tag}>`);
  });

  it('appends when the field has no owned reference', () => {
    assert.equal(setOwnedAudio('<img src="p.jpg">', 'c.mp3', () => true), '<img src="p.jpg">[sound:c.mp3]');
    assert.equal(setOwnedAudio('', 'c.mp3', () => true), '[sound:c.mp3]');
    assert.equal(setOwnedAudio('', 'c.mp3', () => true, 'html'), '<audio src="c.mp3"></audio>');
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
