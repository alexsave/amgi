import next from 'eslint-config-next/core-web-vitals';
import globals from 'globals';

// The `globals` package ships one key with a trailing space
// ("AudioWorkletGlobalScope "), which eslint 9 rejects outright. Trimming is
// cheaper than pinning a different version of a package we only want a list
// of names from.
const clean = (source) =>
  Object.fromEntries(Object.entries(source).map(([name, value]) => [name.trim(), value]));

// `archives/` holds retired code that is not part of the build.
const config = [
  {
    ignores: ['.next/**', 'build/**', 'node_modules/**', 'archives/**'],
  },
  ...next,
  {
    // no-undef, which next/core-web-vitals leaves off.
    //
    // It was off because that preset is built for projects where TypeScript
    // does this job, and this one is plain JavaScript, so nothing was doing
    // it at all. A component was shipped using a `presetText` prop it had
    // never destructured: lint passed, `next build` compiled it happily, and
    // it threw "Can't find variable: presetText" the first time anyone
    // pasted more than one line. A typo in an identifier is exactly the bug
    // a linter should be catching before a person does.
    files: ['src/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      globals: { ...clean(globals.browser), ...clean(globals.node), ...clean(globals.jest), React: 'readonly' },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];

export default config;
