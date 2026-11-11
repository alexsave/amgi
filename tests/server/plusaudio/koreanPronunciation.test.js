'use strict';

// The Korean half of normalizeForComparison (cardText.ts): a transcript and
// the card text are compared by how they sound, not how they are spelled.
//
// The case that made this necessary: every clip of 역이 어디예요? ("where is
// the station?") came back from gpt-transcribe as 여기 어디예요? ("where is
// here?") - the same sounds, since the ㄱ of 역 moves onto the 이 that follows
// it - so every clip failed the transcript check, and the audio judge then
// turned most of them down too.

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { koreanPronunciation, normalizeForComparison } = require('../../../plusaudio/lib/cardGeneration/cardText.ts');

const sameSound = (a, b) => normalizeForComparison(a, 'ko') === normalizeForComparison(b, 'ko');

test('역이 어디예요? and its transcription 여기 어디예요? compare equal', () => {
  assert.ok(sameSound('역이 어디예요?', '여기 어디예요?'));
  assert.ok(sameSound('역이 어디예요?', '여기어디예요'), 'spacing and punctuation do not matter either');
});

test('different sounds stay different: 역이, 여기 and 약이 are not all one', () => {
  assert.ok(sameSound('역이', '여기'));
  assert.ok(!sameSound('역이', '약이'));
  assert.ok(!sameSound('여기', '약이'));
  assert.ok(!sameSound('역', '여기'), 'no liaison without a following vowel');
  assert.ok(!sameSound('역 어디예요', '여기 어디예요'));
  assert.ok(!sameSound('역이 어디예요?', '역 어디예요?'));
  assert.ok(!sameSound('책을 읽어요', '채글 이거요'), 'a cluster moves only its second half');
});

test('only Korean is compared by pronunciation', () => {
  assert.notEqual(normalizeForComparison('역이'), normalizeForComparison('여기'));
  assert.notEqual(normalizeForComparison('역이', 'ja'), normalizeForComparison('여기', 'ja'));
  assert.equal(normalizeForComparison('역이', 'ko-KR'), normalizeForComparison('여기', 'ko'));
});

// Every rule koreanPronunciation claims to cover, with the textbook example
// for it (표준 발음법) and the pronunciation that example has.
const RULES = {
  'liaison (연음)': [['역이', '여기'], ['책을', '채글'], ['있어', '이써'], ['꽃이', '꼬치']],
  'liaison of a cluster': [['읽어', '일거'], ['앉아', '안자'], ['없어', '업써'], ['넋이', '넉씨']],
  'palatalisation (구개음화)': [['같이', '가치'], ['굳이', '구지'], ['닫히다', '다치다']],
  'ㅎ final': [['좋다', '조타'], ['많고', '만코'], ['좋소', '조쏘'], ['놓는', '논는'], ['좋아', '조아'], ['싫어', '시러'], ['뚫는', '뚤른']],
  'ㅎ initial': [['축하', '추카'], ['입학', '이팍'], ['앉히다', '안치다'], ['밝히다', '발키다'], ['옷한벌', '오탄벌']],
  'final neutralisation': [['낮', '낟'], ['낫', '낟'], ['부엌', '부억'], ['앞', '압'], ['맑게', '말께']],
  'nasalisation (비음화)': [['국물', '궁물'], ['합니다', '함니다'], ['받는', '반는'], ['종로', '종노'], ['국력', '궁녁']],
  'lateralisation (유음화)': [['신라', '실라'], ['설날', '설랄']],
  'tensification (경음화)': [['학교', '학꾜'], ['먹다', '먹따'], ['앉다', '안따'], ['젊다', '점따']],
};

for (const [rule, cases] of Object.entries(RULES)) {
  test(`${rule}: ${cases.map(([written]) => written).join(', ')}`, () => {
    for (const [written, spoken] of cases) {
      assert.equal(koreanPronunciation(written), spoken, `${written} should sound like ${spoken}`);
    }
  });
}

test('예 after an open syllable sounds like 에, and only there', () => {
  // Gemini's transcriber wrote 여기 어디에요? for one of eight real clips of 역이 어디예요?.
  assert.ok(sameSound('역이 어디예요?', '여기 어디에요?'));
  assert.ok(sameSound('의자예요', '의자에요'));
  assert.equal(koreanPronunciation('어디예요'), '어디에요');
  assert.equal(koreanPronunciation('예'), '예', 'a word-initial 예 keeps its glide');
  assert.ok(!sameSound('예', '에'));
  assert.ok(!sameSound('시계', '시게'), 'ㅖ after a consonant (계) is outside the rule');
  assert.equal(koreanPronunciation('책예'), '채계', 'after a consonant the final moves over and 예 keeps its glide');
});

test('the homophones the rules create compare equal; the transcriber may write either', () => {
  assert.ok(sameSound('낮', '낫'));
  assert.ok(sameSound('같이 가요', '가치 가요'));
  assert.ok(sameSound('국물이 맛있어요', '궁무리 마시써요'));
  assert.ok(sameSound('좋아요', '조아요'));
});

test('anything that is not a Hangul syllable passes through and blocks the rules', () => {
  assert.equal(koreanPronunciation('KTX역이'), 'KTX여기');
  assert.equal(koreanPronunciation('역 이'), '역 이', 'a space left in (normalizeForComparison removes them first) is a boundary');
  assert.equal(koreanPronunciation('역1이'), '역1이');
  assert.equal(koreanPronunciation(''), '');
});
