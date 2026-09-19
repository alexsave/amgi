'use strict';

// A minimal ZIP reader and writer for .apkg files.
//
// Written by hand rather than pulled from npm because this package's only other
// native dependency (better-sqlite3) needs a compiler and was the main reason
// the tool could not be run on a fresh checkout. With node:sqlite and this file
// the CLI and its tests run on a bare Node install with nothing to build.
//
// Scope is deliberately narrow: the members Anki writes (stored or deflated,
// no encryption, no multi-disk), plus ZIP64 because a deck with a few thousand
// media files can pass the 65,535-entry and 4 GiB limits of the classic format.

const zlib = require('node:zlib');
const fs = require('node:fs');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const U32_MAX = 0xffffffff;
const U16_MAX = 0xffff;

// Fixed DOS timestamp (1980-01-01 00:00:00), the earliest the format can
// express. Real times would make otherwise identical runs differ byte for byte,
// which is the property the idempotence tests check.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function findEndOfCentralDirectory(buf) {
  const minOffset = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLength = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLength === buf.length) return i;
  }
  throw new Error('not a zip file: no end-of-central-directory record');
}

function readCentralDirectoryLocation(buf) {
  const eocd = findEndOfCentralDirectory(buf);
  let entryCount = buf.readUInt16LE(eocd + 10);
  let directoryOffset = buf.readUInt32LE(eocd + 16);

  const needsZip64 = entryCount === U16_MAX || directoryOffset === U32_MAX;
  if (needsZip64) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== SIG_ZIP64_LOCATOR) {
      throw new Error('zip claims ZIP64 but has no ZIP64 locator');
    }
    const zip64Eocd = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(zip64Eocd) !== SIG_ZIP64_EOCD) {
      throw new Error('ZIP64 end-of-central-directory record is missing');
    }
    entryCount = Number(buf.readBigUInt64LE(zip64Eocd + 32));
    directoryOffset = Number(buf.readBigUInt64LE(zip64Eocd + 48));
  }

  return { entryCount, directoryOffset };
}

// ZIP64 moves oversized values out of the fixed-width header into extra field
// 0x0001, in a fixed order, present only for the fields that overflowed.
function applyZip64Extra(extra, entry) {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    const body = extra.subarray(pos + 4, pos + 4 + size);
    pos += 4 + size;
    if (id !== 0x0001) continue;

    let at = 0;
    if (entry.uncompressedSize === U32_MAX && at + 8 <= body.length) {
      entry.uncompressedSize = Number(body.readBigUInt64LE(at));
      at += 8;
    }
    if (entry.compressedSize === U32_MAX && at + 8 <= body.length) {
      entry.compressedSize = Number(body.readBigUInt64LE(at));
      at += 8;
    }
    if (entry.localHeaderOffset === U32_MAX && at + 8 <= body.length) {
      entry.localHeaderOffset = Number(body.readBigUInt64LE(at));
    }
    return;
  }
}

function decodeName(raw, flags) {
  // Bit 11 promises UTF-8. Anki writes ASCII member names either way, and
  // latin1 is the conventional fallback for the rest.
  return raw.toString(flags & 0x0800 ? 'utf8' : 'latin1');
}

function entryData(buf, entry) {
  const local = entry.localHeaderOffset;
  if (buf.readUInt32LE(local) !== SIG_LOCAL) {
    throw new Error(`bad local header for ${entry.name}`);
  }
  // The central directory is authoritative for sizes: a local header written by
  // a streaming producer can carry zeros and defer them to a data descriptor.
  const nameLength = buf.readUInt16LE(local + 26);
  const extraLength = buf.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const raw = buf.subarray(start, start + entry.compressedSize);

  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);

  if (zlib.crc32(data) !== entry.crc32) {
    throw new Error(`crc mismatch for zip member ${entry.name}`);
  }
  return data;
}

/**
 * Read a zip file into a list of entries, in central-directory order.
 * Each entry exposes `data()`, decompressed and CRC-checked on demand.
 */
function readZip(filePath) {
  const buf = fs.readFileSync(filePath);
  const { entryCount, directoryOffset } = readCentralDirectoryLocation(buf);

  const entries = [];
  let pos = directoryOffset;
  for (let i = 0; i < entryCount; i += 1) {
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error('corrupt central directory');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const entry = {
      name: decodeName(buf.subarray(pos + 46, pos + 46 + nameLength), flags),
      method: buf.readUInt16LE(pos + 10),
      crc32: buf.readUInt32LE(pos + 16),
      compressedSize: buf.readUInt32LE(pos + 20),
      uncompressedSize: buf.readUInt32LE(pos + 24),
      localHeaderOffset: buf.readUInt32LE(pos + 42),
    };
    applyZip64Extra(buf.subarray(pos + 46 + nameLength, pos + 46 + nameLength + extraLength), entry);
    entry.data = () => entryData(buf, entry);
    entries.push(entry);
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function zip64ExtraField(uncompressedSize, compressedSize, localHeaderOffset) {
  const body = Buffer.alloc(24);
  body.writeBigUInt64LE(BigInt(uncompressedSize), 0);
  body.writeBigUInt64LE(BigInt(compressedSize), 8);
  body.writeBigUInt64LE(BigInt(localHeaderOffset), 16);
  const field = Buffer.alloc(28);
  field.writeUInt16LE(0x0001, 0);
  field.writeUInt16LE(24, 2);
  body.copy(field, 4);
  return field;
}

/**
 * Write a zip file.
 *
 * @param {string} filePath
 * @param {Array<{name: string, data: Buffer|function(): Buffer, store?: boolean}>} entries
 *   `data` may be a function so that a member's contents are materialised only
 *   while it is being written: a deck with a gigabyte of media should not need a
 *   gigabyte of live buffers. `store` skips deflate for members that are already
 *   compressed (mp3, jpg), where deflate costs time and gains nothing.
 */
function writeZip(filePath, entries) {
  const fd = fs.openSync(filePath, 'w');
  try {
    writeEntries(fd, entries);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(filePath, { force: true });
    throw error;
  }
  fs.closeSync(fd);
}

function writeEntries(fd, entries) {
  const central = [];
  let offset = 0;
  const emit = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const isUtf8 = name.toString('utf8') !== entry.name || /[^\x20-\x7e]/.test(entry.name);
    const flags = isUtf8 ? 0x0800 : 0;
    const store = entry.store === true;
    const data = typeof entry.data === 'function' ? entry.data() : entry.data;
    const payload = store ? data : zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const localHeaderOffset = offset;

    // ZIP64 is per entry: only members that overflow a 32-bit field need it.
    const needsZip64 =
      data.length > U32_MAX || payload.length > U32_MAX || localHeaderOffset > U32_MAX;
    const extra = needsZip64
      ? zip64ExtraField(data.length, payload.length, localHeaderOffset)
      : Buffer.alloc(0);
    const storedSize = needsZip64 ? U32_MAX : data.length;
    const storedCompSize = needsZip64 ? U32_MAX : payload.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(needsZip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(storedCompSize, 18);
    local.writeUInt32LE(storedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);

    emit(local);
    emit(name);
    if (extra.length > 0) emit(extra);
    emit(payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(SIG_CENTRAL, 0);
    dir.writeUInt16LE(needsZip64 ? 45 : 20, 4);
    dir.writeUInt16LE(needsZip64 ? 45 : 20, 6);
    dir.writeUInt16LE(flags, 8);
    dir.writeUInt16LE(store ? 0 : 8, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(storedCompSize, 20);
    dir.writeUInt32LE(storedSize, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(extra.length, 30);
    dir.writeUInt32LE(needsZip64 ? U32_MAX : localHeaderOffset, 42);
    central.push(dir, name, extra);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const part of central) directorySize += part.length;
  for (const part of central) emit(part);

  const needsZip64End =
    entries.length > U16_MAX || directoryOffset > U32_MAX || directorySize > U32_MAX;
  if (needsZip64End) {
    const zip64 = Buffer.alloc(56);
    zip64.writeUInt32LE(SIG_ZIP64_EOCD, 0);
    zip64.writeBigUInt64LE(44n, 4); // size of the remainder of this record
    zip64.writeUInt16LE(45, 12);
    zip64.writeUInt16LE(45, 14);
    zip64.writeBigUInt64LE(BigInt(entries.length), 24);
    zip64.writeBigUInt64LE(BigInt(entries.length), 32);
    zip64.writeBigUInt64LE(BigInt(directorySize), 40);
    zip64.writeBigUInt64LE(BigInt(directoryOffset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
    locator.writeBigUInt64LE(BigInt(directoryOffset + directorySize), 8);
    locator.writeUInt32LE(1, 16);
    emit(zip64);
    emit(locator);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(needsZip64End ? U16_MAX : entries.length, 8);
  eocd.writeUInt16LE(needsZip64End ? U16_MAX : entries.length, 10);
  eocd.writeUInt32LE(needsZip64End ? U32_MAX : directorySize, 12);
  eocd.writeUInt32LE(needsZip64End ? U32_MAX : directoryOffset, 16);
  emit(eocd);
}

module.exports = { readZip, writeZip };
