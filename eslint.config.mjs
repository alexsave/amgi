import next from 'eslint-config-next/core-web-vitals';

export default [
  {
    ignores: ['.next/**', 'build/**', 'node_modules/**', 'plusaudio/**', 'supabase/**'],
  },
  ...next,
];
