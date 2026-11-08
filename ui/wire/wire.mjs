// The Node binding of ui/wire: the server writes every /api/anki answer and reads every request
// body in amgi's wire format through ui/out/wire.wasm. This file knows no layout and no field
// name: the C walkers (ui/wire/wire_node.c) ask it for a value by the schema's key, or tell it a
// (key, value) to set, and it only looks the key up on the object in hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WIRE_MIME = 'application/x-amgi-wire';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(here, '..', 'out', 'wire.wasm');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

let w;                          // the module's exports
let stack = [];                 // the objects in hand, innermost last
let kept;                       // the string str_len encoded, for str_copy
let openList = new WeakMap();   // an object being built -> the array its push_* calls fill
const text = (p, n) => (n ? decoder.decode(new Uint8Array(w.memory.buffer, p, n)) : '');
const current = () => stack[stack.length - 1];
// A dotted key's value on the object in hand; "" is the object in hand itself.
function lookup(p, n) {
  let value = current();
  if (!n) return value;
  for (const part of text(p, n).split('.')) value = value == null ? undefined : value[part];
  return value;
}

const imports = {
  wire: {
    num(p, n) {
      const v = lookup(p, n);
      return typeof v === 'number' ? v : typeof v === 'boolean' ? +v : NaN;
    },
    tri(p, n) {
      const v = lookup(p, n);
      return v === true ? 1 : v === false ? 0 : 2;
    },
    str_len(p, n) {
      const v = lookup(p, n);
      kept = encoder.encode(typeof v === 'string' ? v : '');
      return kept.length;
    },
    bytes_len(p, n) {
      const v = lookup(p, n);
      kept = v instanceof Uint8Array ? v : new Uint8Array(0);
      return kept.length;
    },
    str_copy(dst) {
      new Uint8Array(w.memory.buffer, dst, kept.length).set(kept);
    },
    count(p, n) {
      const v = lookup(p, n);
      return Array.isArray(v) ? v.length : 0;
    },
    enter(p, n, i) {
      stack.push(lookup(p, n)[i]);
    },
    leave() {
      stack.pop();
    },
    set_num(p, n, v) {
      current()[text(p, n)] = v;
    },
    set_bool(p, n, v) {
      current()[text(p, n)] = v === 1;
    },
    set_str(p, n, sp, sn) {
      current()[text(p, n)] = text(sp, sn);
    },
    set_bytes(p, n, sp, sn) {
      current()[text(p, n)] = Buffer.from(new Uint8Array(w.memory.buffer, sp, sn));
    },
    set_list(p, n) {
      const list = [];
      current()[text(p, n)] = list;
      openList.set(current(), list);
    },
    push_str(sp, sn) {
      openList.get(current()).push(text(sp, sn));
    },
    push_obj() {
      const item = {};
      openList.get(current()).push(item);
      stack.push(item);
    },
  },
};
w = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasmPath)), imports).exports;

// The kinds by name, as wire.c's table spells them.
export const KIND = {};
for (let k = 0; ; k++) {
  const p = w.w_kind_name(k);
  if (!p) break;
  const bytes = new Uint8Array(w.memory.buffer, p);
  KIND[decoder.decode(bytes.subarray(0, bytes.indexOf(0)))] = k;
}

// The bridge protocol's version (wire.h, WIRE_BRIDGE_PROTOCOL): the add-on must speak the same one.
export const BRIDGE_PROTOCOL = w.w_bridge_protocol();

// An answer object as a message of kind (a name in KIND).
export function encode(kind, object) {
  if (!(kind in KIND)) throw new Error(`no wire kind ${kind}`);
  stack = [object];
  try {
    w.w_encode(KIND[kind]);
  } finally {
    stack = [];
  }
  return Buffer.from(new Uint8Array(w.memory.buffer, w.w_ptr(), w.w_len()));
}

// A request body of kind as a new object, or null for bytes that are not one.
export function decode(kind, bytes) {
  if (!(kind in KIND)) throw new Error(`no wire kind ${kind}`);
  const at = w.w_scratch(bytes.length);
  new Uint8Array(w.memory.buffer, at, bytes.length).set(bytes);
  const object = {};
  stack = [object];
  openList = new WeakMap();
  try {
    return w.w_decode(KIND[kind], at, bytes.length) ? object : null;
  } finally {
    stack = [];
  }
}
