'use strict';

// The one random source in this codebase.
//
// Every random draw amgi makes - which Gemini voice reads a clip, the bits of
// a new note's guid - comes from a generator made here, and from nowhere
// else: no Math.random, no crypto.randomBytes / randomUUID / getRandomValues,
// no seed taken from the clock. test/random.test.js greps the repo
// for those and fails on any it finds outside this file.
//
// To make every run reproducible, change SEED below to a constant (any
// 32-bit integer, e.g. `const SEED = 1;`). That one line is the whole switch:
// the same seed and the same inputs then give the same voices and the same
// guids on every run. Left as null, the process draws one seed from the OS
// when this module loads, which is the only non-deterministic step there is.
//
// A fixed seed is for debugging only. Two runs with the same seed produce the
// same note guids, and Anki treats a matching guid as "the same note", so a
// fixed seed must never reach a collection someone keeps.

const crypto = require('node:crypto');

/** null: seed from the OS once per process. A number: deterministic. */
const SEED = null;

function osSeed() {
  return crypto.randomBytes(4).readUInt32LE(0);
}

/** splitmix32, used only to spread one 32-bit seed over sfc32's 128-bit state. */
function splitmix32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
    return (z ^ (z >>> 16)) >>> 0;
  };
}

/**
 * The one generator type: sfc32 (Chris Doty-Humphrey's small fast chaotic
 * generator). Not cryptographic, and nothing here needs it to be.
 *
 * Every method makes a fixed number of draws (no rejection sampling), so the
 * number of draws a caller makes never depends on the values it gets back -
 * which is what lets a test compare raw draw sequences across runs.
 */
class Random {
  constructor(seed) {
    if (!Number.isInteger(seed)) throw new Error(`a Random needs an integer seed, got ${seed}`);
    this.seed = seed >>> 0;
    const mix = splitmix32(this.seed);
    this.a = mix();
    this.b = mix();
    this.c = mix();
    this.d = mix();
    // sfc32's own warm-up, so nearby seeds do not start out correlated.
    for (let i = 0; i < 12; i += 1) this.uint32();
  }

  /** One draw: a uniform 32-bit unsigned integer. */
  uint32() {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** One draw: an integer in [0, n). */
  int(n) {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`int() needs a positive integer bound, got ${n}`);
    return Math.floor((this.uint32() / 0x100000000) * n);
  }

  /** `count` bytes, one draw per 4 bytes. */
  bytes(count) {
    const out = Buffer.alloc(count);
    for (let i = 0; i < count; i += 4) {
      const word = this.uint32();
      for (let j = 0; j < 4 && i + j < count; j += 1) out[i + j] = (word >>> (8 * j)) & 0xff;
    }
    return out;
  }
}

/** A generator of its own, for a test that needs a known sequence. */
function createRandom(seed) {
  return new Random(seed);
}

/** The process-wide generator every shipped draw goes through. */
const random = new Random(SEED === null ? osSeed() : SEED);

module.exports = { Random, SEED, createRandom, random };
