import next from 'eslint-config-next/core-web-vitals';

// `archives/` holds retired code that is not part of the build.
const config = [
  {
    ignores: ['.next/**', 'build/**', 'node_modules/**', 'supabase/**', 'archives/**'],
  },
  ...next,
];

export default config;
