import js from '@eslint/js';
import globals from 'globals';

// The `globals` package ships one key with a trailing space
// ("AudioWorkletGlobalScope "), which eslint 9 rejects outright. Trimming is
// cheaper than pinning a different version of a package we only want a list
// of names from.
const clean = (source) =>
  Object.fromEntries(Object.entries(source).map(([name, value]) => [name.trim(), value]));

const config = [
  {
    ignores: ['node_modules/**', 'ui/out/**', 'cdom/**', 'cbase/**', '.e2e/**', '.next/**', 'plusaudio/vendor/**', 'archives/**'],
  },
  js.configs.recommended,
  {
    // no-undef is the rule that matters most in plain JavaScript: nothing else catches a typo in an
    // identifier before a person does.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...clean(globals.browser), ...clean(globals.node) },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
    },
  },
  {
    // anki/tools/build-loop.sh concatenates voiceActivity.js and reviewLoop.js in front of this file,
    // so these names are defined by the time it runs, just not in this file.
    files: ['anki/src/anki-loop.js'],
    languageOptions: { globals: { createReviewLoop: 'readonly', detectSpeechEnd: 'readonly', PHASE: 'readonly' } },
  },
];

export default config;
