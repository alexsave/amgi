import { correctSwappedSides } from '../../server/anki/sideOrder';

// A card whose two sides came back the wrong way round.
//
// front_text is the language the learner knows, back_text the one they are
// learning, and the model decides which is which by reading the input. On a
// line that mixes scripts it gets it wrong, and the result is not a cosmetic
// one: the card asks the learner to produce their own language, and the
// learning-language voice records the English sentence.

const ko = (front, back, reading = '') => ({ front_text: front, back_text: back, spoken_reading: reading });

describe('putting a card’s two sides the right way round', () => {
  it('swaps the Korean lyric that mixed in an English phrase', () => {
    // The exact row from a real deck: "still with you" inside a Korean line
    // was enough for the model to call the whole thing English.
    const out = correctSwappedSides(
      ko('그대 향해 한 걸음씩 걸어갈래요, still with you', 'I will walk toward you one step at a time, still with you'),
      'ko',
    );
    expect(out.sidesSwapped).toBe(true);
    expect(out.back_text).toBe('그대 향해 한 걸음씩 걸어갈래요, still with you');
    expect(out.front_text).toBe('I will walk toward you one step at a time, still with you');
  });

  it('swaps a plain reversal with no mixed script at all', () => {
    const out = correctSwappedSides(ko('어두운 방, 조명 하나 없이', 'A dark room with no lights'), 'ko');
    expect(out.sidesSwapped).toBe(true);
    expect(out.back_text).toBe('어두운 방, 조명 하나 없이');
  });

  it('leaves a correct card completely alone', () => {
    const text = ko('hello', '안녕하세요');
    expect(correctSwappedSides(text, 'ko')).toBe(text);
  });

  it('throws away a reading that described the other sentence', () => {
    // spoken_reading steers the pronunciation of the clip recorded next, so
    // one written for the wrong side is worse than none.
    const out = correctSwappedSides(
      { front_text: '行った', back_text: 'went', spoken_reading: 'いった' },
      'ja',
    );
    expect(out.sidesSwapped).toBe(true);
    expect(out.spoken_reading).toBe('');
  });

  it('does nothing for a learning language that shares our alphabet', () => {
    // Spanish and English cannot be told apart by script, so guessing here
    // would break correct cards to fix ones it cannot even detect.
    const text = ko('the weekend', 'el fin de semana');
    expect(correctSwappedSides(text, 'es')).toBe(text);
  });

  it('leaves a card alone when both sides carry the script', () => {
    const text = ko('안녕', '안녕하세요');
    expect(correctSwappedSides(text, 'ko')).toBe(text);
  });

  it('leaves a card alone when the front is empty', () => {
    const text = ko('', 'anything');
    expect(correctSwappedSides(text, 'ko')).toBe(text);
  });
});
