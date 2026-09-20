// The one interface, two implementations, chosen at runtime.
//
// Every route handler under src/app/api/anki/ calls resolveTransport(settings)
// at the top of the request and gets back an object shaped the same way
// regardless of which real backend answered it - see bridgeClient.js and
// directClient.js, which both build to this same `ops` shape. Nothing here is
// cached across requests: a fresh probe runs every single call, which is what
// makes "re-probe when the situation changes" true for free rather than
// something a polling loop has to force. The UI's status banner just calls
// the /api/anki/status route on an interval; every other action re-probes as
// a side effect of being asked to do anything at all.
//
// This file - and everything it requires (plusaudio/lib/collection, which
// touches node:sqlite and the filesystem) - must only ever be imported from
// a Next.js route handler (src/app/api/**/route.js). Route handlers run in
// the Node.js runtime on the server, never in the browser bundle, which is
// what keeps the filesystem and localhost reachability on the correct side
// of the client/server line (see the task this was built from: "this runs on
// the user's machine, so the filesystem work belongs on the server side of
// Next.js"). Nothing under src/components or src/contexts may require this
// file directly - they only ever reach it through fetch() to /api/anki/*.

import fs from 'node:fs';
import { defaultBaseDir, listProfiles } from 'plusaudio/lib/collection';
import { probeBridge } from './bridgeClient';
import { createDirectOps, DirectError } from './directClient';

/**
 * Wraps `ops.listNotesInDeck` so callers get the same {notes, offset, limit,
 * hasMore} shape no matter which transport answered - bridge's own response
 * carries `total` instead of `hasMore` (see bridgeClient.js), so that's
 * translated here rather than leaking the difference to every route.
 */
function withNormalizedPaging(ops) {
  return {
    ...ops,
    async listNotesInDeck(deckId, options) {
      const page = await ops.listNotesInDeck(deckId, options);
      if ('hasMore' in page) return page;
      return { notes: page.notes, offset: page.offset, limit: page.limit, hasMore: page.offset + page.notes.length < page.total };
    },
  };
}

/**
 * Resolve which transport to use right now, and hand back a ready-to-call
 * `ops` object when there is one.
 *
 * @returns one of:
 *   { mode: 'unconfigured' }                                no profile chosen yet
 *   { mode: 'not-found' }                                    chosen collection file is gone
 *   { mode: 'unsupported-schema', schemaVersion }
 *   { mode: 'locked' }                                        Anki has the file open and no bridge answered
 *   { mode: 'bridge', ops, detail }                           the add-on's HTTP bridge answered
 *   { mode: 'direct', ops }                                   read the closed file straight off disk
 */
export async function resolveTransport(settings) {
  if (settings.bridge?.baseUrl && settings.bridge.token) {
    const probed = await probeBridge(settings.bridge.baseUrl, settings.bridge.token);
    if (probed) {
      if (!probed.status.collectionOpen) {
        return { mode: 'bridge-no-collection', detail: probed.status };
      }
      return { mode: 'bridge', ops: withNormalizedPaging(probed.ops), detail: probed.status };
    }
    // Bridge configured but unreachable (Anki closed, add-on off, wrong
    // port/token): fall through to the direct file transport rather than
    // reporting failure - the whole point of "pick whichever is available".
  }

  if (!settings.collectionPath) {
    return { mode: 'unconfigured' };
  }

  const ops = createDirectOps(settings.collectionPath);
  try {
    const status = await ops.status();
    if (status.status === 'ok') {
      return { mode: 'direct', ops: withNormalizedPaging(ops), schemaVersion: status.schemaVersion };
    }
    return { mode: status.status }; // 'locked' | 'not-found' | 'unsupported-schema'
  } catch (error) {
    if (error instanceof DirectError) return { mode: error.kind };
    throw error;
  }
}

/** Every profile amgi can find, plus whether it even found an Anki data folder at all. */
export function discoverProfiles(baseDirOverride) {
  const baseDir = baseDirOverride || defaultBaseDir();
  const baseDirExists = fs.existsSync(baseDir);
  const profiles = baseDirExists ? listProfiles(baseDir) : [];
  return { baseDir, baseDirExists, profiles };
}
