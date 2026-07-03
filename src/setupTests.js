// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// jsdom doesn't provide TextEncoder/TextDecoder, which react-router v7 needs.
import { TextEncoder, TextDecoder } from 'util';
if (typeof global.TextEncoder === 'undefined') {
  global.TextEncoder = TextEncoder;
  global.TextDecoder = TextDecoder;
}

// The supabase client is created at module load; give it harmless defaults
// so importing app modules doesn't crash in tests.
process.env.REACT_APP_SUPABASE_URL = process.env.REACT_APP_SUPABASE_URL || 'http://localhost:54321';
process.env.REACT_APP_SUPABASE_KEY = process.env.REACT_APP_SUPABASE_KEY || 'test-anon-key';
