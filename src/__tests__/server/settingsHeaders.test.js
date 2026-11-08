/**
 * @jest-environment node
 */
const { readSettings, PLAIN_HEADERS } = require('../../server/anki/settings');

const request = (headers) => new Request('http://127.0.0.1/api/anki/status', { headers });

describe('readSettings', () => {
  it('reads the plain headers, percent-decoding UTF-8', () => {
    const settings = readSettings(request({
      [PLAIN_HEADERS.collectionPath]: encodeURIComponent('/Users/me/Anki2/사용자 1/collection.anki2'),
      [PLAIN_HEADERS.profileName]: encodeURIComponent('사용자 1'),
      [PLAIN_HEADERS.bridgeToken]: 'abc',
    }));
    expect(settings).toEqual({
      baseDirOverride: '',
      collectionPath: '/Users/me/Anki2/사용자 1/collection.anki2',
      profileName: '사용자 1',
      bridge: { baseUrl: '', token: 'abc' },
    });
  });

  it('prefers the plain headers over the JSON header', () => {
    const settings = readSettings(request({
      [PLAIN_HEADERS.baseDirOverride]: '%2Ftmp%2Fa',
      'x-amgi-anki-settings': JSON.stringify({ baseDirOverride: '/tmp/b' }),
    }));
    expect(settings.baseDirOverride).toBe('/tmp/a');
  });

  it('still reads the JSON header the documented API sends', () => {
    const settings = readSettings(request({
      'x-amgi-anki-settings': JSON.stringify({ collectionPath: '/c', bridge: { baseUrl: 'http://x', token: 't' } }),
    }));
    expect(settings).toEqual({ baseDirOverride: '', collectionPath: '/c', profileName: '', bridge: { baseUrl: 'http://x', token: 't' } });
  });

  it('reads a malformed escape as empty, not as a thrown request', () => {
    expect(readSettings(request({ [PLAIN_HEADERS.collectionPath]: '%E0%A4%A' })).collectionPath).toBe('');
  });
});
