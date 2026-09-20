import { ankiApi } from '../../utils/ankiApi';

// A regression test for a bug that installed add-ons into the wrong Anki.
//
// The Settings panel keeps an unsaved "Anki data folder override" in React
// state, while ankiApi's shared header carries the SAVED settings. Install
// originally sent no body at all, so the server fell back to the saved
// override - which for anyone who had typed a folder but not pressed Save
// meant the button quietly wrote two add-ons into their default Anki profile
// instead of the folder on screen. It was caught by driving the real button
// in a browser and finding the files somewhere else entirely.
//
// The fix is that the override travels in the request body, explicitly. This
// pins that: the body is the contract, not an implementation detail.

describe('ankiApi.install', () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, message: 'Installed.', addonsDir: '/tmp/x/addons21' }),
    });
    global.fetch = fetchMock;
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  const bodyOf = () => JSON.parse(fetchMock.mock.calls[0][1].body);

  it('sends the folder it was given, not whatever is saved', async () => {
    await ankiApi.install('/tmp/some-other-anki');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/anki/install');
    expect(options.method).toBe('POST');
    expect(bodyOf().baseDirOverride).toBe('/tmp/some-other-anki');
  });

  it('sends an empty override when there is none, so the server picks the default', async () => {
    await ankiApi.install();
    expect(bodyOf().baseDirOverride).toBe('');
  });

  it('sends an empty override rather than the string "undefined"', async () => {
    await ankiApi.install(undefined);
    expect(bodyOf().baseDirOverride).toBe('');
  });
});
