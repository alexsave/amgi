'use strict';

// Seeds the browser's `amgi:anki-settings` localStorage entry before the
// app's own JS runs, so a puppeteer session opens already pointed at a
// fixture collection - no click-through of the Settings page's profile
// scanner required. Same evaluateOnNewDocument idiom fakevoice.js uses for
// the microphone.
//
// See src/utils/ankiSettings.js for the shape this writes and who reads it,
// and src/server/anki/transport.js for what each field controls.

/** The full settings shape src/utils/ankiSettings.js expects; fields not passed keep their default. */
function directSettings(collectionPath, overrides = {}) {
  return {
    baseDirOverride: '',
    collectionPath,
    profileName: '',
    bridge: { enabled: false, baseUrl: 'http://127.0.0.1:8798', token: '' },
    ...overrides,
  };
}

function ankiSettingsScript(settings) {
  const payload = JSON.stringify(settings);
  // JSON.stringify(payload) turns the JSON text itself into a safely quoted
  // and escaped JS string literal - no manual escaping to get wrong.
  return `window.localStorage.setItem('amgi:anki-settings', ${JSON.stringify(payload)});`;
}

module.exports = ankiSettingsScript;
module.exports.directSettings = directSettings;
