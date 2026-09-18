import next from 'eslint-config-next/core-web-vitals';

// `archives/` and `plusaudio/` hold retired code that is not part of the build.
const config = [
  {
    ignores: ['.next/**', 'build/**', 'node_modules/**', 'plusaudio/**', 'supabase/**', 'archives/**'],
  },
  ...next,
];

export default config;
