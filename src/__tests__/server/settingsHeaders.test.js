import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readSettings, settingsHeaders, PLAIN_HEADERS } from '../../server/anki/settings';

const request = (headers) => new Request('http://127.0.0.1/api/anki/status', { headers });

describe('readSettings', () => {
  test('reads the plain headers, percent-decoding UTF-8', () => {
    const settings = readSettings(request({
      [PLAIN_HEADERS.collectionPath]: encodeURIComponent('/Users/me/Anki2/사용자 1/collection.anki2'),
      [PLAIN_HEADERS.profileName]: encodeURIComponent('사용자 1'),
      [PLAIN_HEADERS.bridgeToken]: 'abc',
    }));
    assert.deepEqual(settings, {
      baseDirOverride: '',
      collectionPath: '/Users/me/Anki2/사용자 1/collection.anki2',
      profileName: '사용자 1',
      bridge: { baseUrl: '', token: 'abc' },
    });
  });

  test('reads every setting as empty when no header carries it', () => {
    assert.deepEqual(readSettings(request({})), { baseDirOverride: '', collectionPath: '', profileName: '', bridge: { baseUrl: '', token: '' } });
  });

  test('settingsHeaders writes what readSettings reads back', () => {
    const settings = { baseDirOverride: '/tmp/한국어 a', collectionPath: '/c%d', profileName: 'User 1', bridge: { baseUrl: 'http://127.0.0.1:8798', token: 't&k' } };
    assert.deepEqual(readSettings(request(settingsHeaders(settings))), settings);
  });

  test('reads a malformed escape as empty, not as a thrown request', () => {
    assert.equal(readSettings(request({ [PLAIN_HEADERS.collectionPath]: '%E0%A4%A' })).collectionPath, '');
  });
});
