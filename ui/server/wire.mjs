// The Node binding of ui/wire/wire.c: the server writes the /api/anki answers in amgi's wire format
// by calling the C writers in ui/out/wire.wasm. This file knows no layout: it copies each call's
// strings into the module's memory and passes numbers through, so a field's order and width stay
// written down only in wire.c. The encoders below say which writer each route's answer goes to.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIRE_MIME = 'application/x-amgi-wire';
const KIND = { error: 0, status: 1, decks: 2, install: 3, profiles: 4 }; // wire.h's enum
const NO_RETRY = 0xffffffff;
const UNKNOWN = 2;

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, '..', 'out', 'wire.wasm');
const { exports: w } = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasmPath)), {});
const encoder = new TextEncoder();

// The strings of one call, copied into room the module makes, as [ptr, len] pairs in order.
function strings(...values) {
  const encoded = values.map((v) => encoder.encode(typeof v === 'string' ? v : ''));
  let at = w.w_scratch(encoded.reduce((n, e) => n + e.length, 0));
  const view = new Uint8Array(w.memory.buffer);
  return encoded.flatMap((e) => {
    view.set(e, at);
    const pair = [at, e.length];
    at += e.length;
    return pair;
  });
}
function finish() {
  return Buffer.from(new Uint8Array(w.memory.buffer, w.w_ptr(), w.w_len()));
}

// Each route's answer object (what the handler passed to NextResponse.json) as wire bytes.
export const encoders = {
  error(body) {
    w.w_begin(KIND.error);
    const flags = (body.notStarted === true ? 1 : 0) | (body.dailyCap === true ? 2 : 0);
    const retry = Number.isFinite(body.retryAfterMs) ? Math.max(0, Math.round(body.retryAfterMs)) : NO_RETRY;
    const [m, ml, e, el] = strings(body.mode, body.error);
    w.w_error(m, ml, retry, flags, e, el);
    return finish();
  },
  status(body) {
    w.w_begin(KIND.status);
    const [m, ml, d, dl] = strings(body.mode, body.detail);
    w.w_status(m, ml, body.schemaVersion >>> 0, d, dl);
    return finish();
  },
  decks(body) {
    w.w_begin(KIND.decks);
    const [m, ml] = strings(body.mode);
    w.w_decks_head(m, ml, body.decks.length);
    for (const deck of body.decks) {
      const [n, nl] = strings(deck.name);
      w.w_deck(Number(deck.id), deck.noteCount >>> 0, n, nl);
    }
    return finish();
  },
  install(body) {
    w.w_begin(KIND.install);
    const tri = (v) => (v === true ? 1 : v === false ? 0 : UNKNOWN);
    w.w_install(+(body.installed === true), tri(body.upToDate), +(body.collectionChecked === true),
      (body.collectionStale || []).length, +(body.ready === true));
    return finish();
  },
  profiles(body) {
    w.w_begin(KIND.profiles);
    const [b, bl] = strings(body.baseDir);
    w.w_profiles_head(b, bl, +(body.baseDirExists === true), body.profiles.length);
    for (const profile of body.profiles) {
      const [n, nl, p, pl] = strings(profile.name, profile.collectionPath);
      w.w_profile(n, nl, p, pl);
    }
    return finish();
  },
};
