const nextJest = require('next/jest');

const createJestConfig = nextJest({ dir: './' });

module.exports = createJestConfig({
  testEnvironment: 'jest-environment-jsdom',
  setupFilesAfterEnv: ['<rootDir>/src/setupTests.js'],
  // plusaudio, anki and ui are node:test suites, run separately by `npm test`; cdom has its own.
  testPathIgnorePatterns: [
    '<rootDir>/.next/',
    '<rootDir>/node_modules/',
    '<rootDir>/plusaudio/',
    '<rootDir>/anki/',
    '<rootDir>/ui/',
    '<rootDir>/cdom/',
  ],
});
