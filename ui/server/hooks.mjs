// Module resolution the route handlers were written against, without Next's bundler: 'next/server'
// is ./next-server.mjs, and an import may name a file without its ".js" or a folder for its
// index.js (webpack's habits, which Node's own ES module resolver refuses). Registered before
// anything under src/ is imported.
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NEXT_SERVER = new URL('./next-server.mjs', import.meta.url).href;
const WEBPACK_HABITS = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/server') return { url: NEXT_SERVER, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!WEBPACK_HABITS.has(error.code) || !error.url?.startsWith('file:')) throw error;
      const base = fileURLToPath(error.url);
      for (const candidate of [`${base}.js`, `${base}/index.js`]) {
        if (fs.existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
      }
      throw error;
    }
  },
});
