// Module resolution the server's code was written against: an import may name a file without its
// ".js" or a folder for its index.js (webpack's habits from the Next days, which Node's own ES module
// resolver refuses). Registered before anything under src/ is imported.
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WEBPACK_HABITS = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

registerHooks({
  resolve(specifier, context, nextResolve) {
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
