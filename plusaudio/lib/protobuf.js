'use strict';

// Just enough protobuf to read and write the metadata Anki puts in an .apkg.
//
// Two of a package's members are protobuf messages rather than text: `meta` is
// a PackageMetadata, and a modern package's `media` is a MediaEntries
// (proto/anki/import_export.proto). Both are a handful of scalar fields, and
// the encoding they use is small: a varint tag whose low three bits are the
// wire type and whose remaining bits are the field number, followed either by
// a varint or by a length and that many bytes. Hand-rolling it is a few dozen
// lines and keeps this package's zero-dependency rule intact, where a protobuf
// runtime would be a megabyte of code and a build step to generate stubs from
// a .proto we would have to keep in sync with Anki's anyway.
//
// https://protobuf.dev/programming-guides/encoding/

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

/**
 * Read one base-128 varint.
 *
 * Accumulated as a double rather than a BigInt: every varint in these messages
 * is a small field number, length, or file size, and the range check makes a
 * value that would lose precision an error instead of a silent wrong answer.
 */
function readVarint(buffer, offset) {
  let value = 0;
  let scale = 1;
  for (let at = offset; at < buffer.length; at += 1) {
    const byte = buffer[at];
    value += (byte & 0x7f) * scale;
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) {
        throw new Error('protobuf varint is too large to read exactly');
      }
      return { value, next: at + 1 };
    }
    scale *= 128;
  }
  throw new Error('truncated protobuf varint');
}

/**
 * Walk a message's fields in the order they were written.
 *
 * A field that is not understood still has to be walked past correctly, which
 * is why the fixed-width wire types are skipped rather than rejected. Groups
 * (wire types 3 and 4) were removed from the language long before any of these
 * messages were written, so meeting one means the bytes are not what we think.
 *
 * @yields {{number: number, wireType: number, value: number, bytes: Buffer|null}}
 */
function* readFields(buffer) {
  let at = 0;
  while (at < buffer.length) {
    const tag = readVarint(buffer, at);
    const number = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    at = tag.next;

    if (wireType === WIRE_VARINT) {
      const field = readVarint(buffer, at);
      at = field.next;
      yield { number, wireType, value: field.value, bytes: null };
    } else if (wireType === WIRE_LENGTH) {
      const length = readVarint(buffer, at);
      const end = length.next + length.value;
      if (end > buffer.length) throw new Error('truncated protobuf field');
      yield { number, wireType, value: 0, bytes: buffer.subarray(length.next, end) };
      at = end;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      const width = wireType === WIRE_FIXED64 ? 8 : 4;
      if (at + width > buffer.length) throw new Error('truncated protobuf field');
      yield { number, wireType, value: 0, bytes: buffer.subarray(at, at + width) };
      at += width;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
}

/** Advance past a varint without decoding it - see readFieldsLenient. */
function skipVarint(buffer, offset) {
  let at = offset;
  while (buffer[at] & 0x80) at += 1;
  return at + 1;
}

/**
 * Like readFields, but a varint field number that is not in `wanted` is
 * skipped rather than decoded into a JS number.
 *
 * readFields (and readVarint underneath it) refuses a varint that cannot be
 * represented exactly as a double, which is the right thing for the small
 * field numbers, lengths and counters this module was first written for -
 * but a real message can legitimately carry a 64-bit value in a field a
 * caller has no interest in (Anki's Notetype.Template.Config.id, for
 * instance, an arbitrary random id nothing here ever reads). Skipping those
 * without decoding them means a message like that can still be read for the
 * one or two fields a caller does want, instead of failing on a field it was
 * never going to look at.
 */
function* readFieldsLenient(buffer, wanted) {
  let at = 0;
  while (at < buffer.length) {
    const tag = readVarint(buffer, at);
    const number = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    at = tag.next;

    if (wireType === WIRE_VARINT) {
      if (wanted.has(number)) {
        const field = readVarint(buffer, at);
        at = field.next;
        yield { number, wireType, value: field.value, bytes: null };
      } else {
        at = skipVarint(buffer, at);
      }
    } else if (wireType === WIRE_LENGTH) {
      const length = readVarint(buffer, at);
      const end = length.next + length.value;
      if (end > buffer.length) throw new Error('truncated protobuf field');
      yield { number, wireType, value: 0, bytes: buffer.subarray(length.next, end) };
      at = end;
    } else if (wireType === WIRE_FIXED64 || wireType === WIRE_FIXED32) {
      const width = wireType === WIRE_FIXED64 ? 8 : 4;
      if (at + width > buffer.length) throw new Error('truncated protobuf field');
      yield { number, wireType, value: 0, bytes: buffer.subarray(at, at + width) };
      at += width;
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`);
    }
  }
}

function writeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`cannot encode ${value} as a protobuf varint`);
  }
  const bytes = [];
  let rest = value;
  do {
    const byte = rest % 128;
    rest = Math.floor(rest / 128);
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function writeTag(number, wireType) {
  return writeVarint(number * 8 + wireType);
}

function writeVarintField(number, value) {
  return Buffer.concat([writeTag(number, WIRE_VARINT), writeVarint(value)]);
}

function writeBytesField(number, bytes) {
  return Buffer.concat([writeTag(number, WIRE_LENGTH), writeVarint(bytes.length), bytes]);
}

module.exports = {
  WIRE_FIXED32,
  WIRE_FIXED64,
  WIRE_LENGTH,
  WIRE_VARINT,
  readFields,
  readFieldsLenient,
  readVarint,
  writeBytesField,
  writeVarint,
  writeVarintField,
};
