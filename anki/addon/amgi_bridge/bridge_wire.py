# The bridge protocol's messages in Python: amgi's wire format (ui/wire/wire.h), read and written
# by walking the schema ui/wire/wire_py.c generates from wire.c into wire_schema.py. This file knows
# the format's types and nothing of any layout: every kind's fields, their order and their names
# come from that table, the same one the app, its server and the server's bridge client walk.
#
# Bytes: little-endian. A string (and bytes) is a u32 count and that many bytes. A list is a u32
# count and its items. A message is the u32 MAGIC, a u8 kind, then the kind's fields.
#
# Values, as bridge_ops.py builds them and as wire_node.c reads a JS object: a missing string is "",
# a missing number 0, a missing OPT field NONE (and None reads back as absent), a missing I32 field
# ABSENT. A dotted name ("deck.id") is a field of a nested dict when writing; reading, it is one
# flat key, as the server's reader makes it.
#
# Pure Python, no anki and no aqt import: test/test_bridge_wire.py runs it as is.

from __future__ import annotations

import math
import struct
from typing import Any, Optional

try:
    from . import wire_schema as S
except ImportError:
    import wire_schema as S  # type: ignore[no-redef]

_U32 = struct.Struct("<I")
_I64 = struct.Struct("<q")


class WireError(ValueError):
    """Bytes that are not one whole message of the kind asked for."""


def _get(obj: Any, key: str) -> Any:
    # A dotted name as one flat key first (what decode makes), else as a path into nested dicts.
    if isinstance(obj, dict) and key in obj:
        return obj[key]
    for part in key.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(part)
    return obj


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)) and not (isinstance(value, float) and math.isnan(value)):
        return float(value)
    return None


def _u32(value: Any, fallback: int) -> int:
    v = _number(value)
    if v is None:
        return fallback
    if v <= 0:
        return 0
    if v >= 4294967295.0:
        return 0xFFFFFFFF
    return int(v + 0.5)


def _write_fields(out: bytearray, fields: tuple, obj: Any) -> None:
    for name, kind, sub in fields:
        value = _get(obj, name)
        if kind == S.BOOL:
            out.append(1 if value is True else 0)
        elif kind == S.TRI:
            out.append(1 if value is True else 0 if value is False else S.UNKNOWN)
        elif kind == S.U32:
            out += _U32.pack(_u32(value, 0))
        elif kind == S.OPT:
            out += _U32.pack(_u32(value, S.NONE))
        elif kind == S.I32:
            v = _number(value)
            out += _U32.pack((S.ABSENT if v is None else int(v)) & 0xFFFFFFFF)
        elif kind == S.I64:
            v = _number(value)
            out += _I64.pack(0 if v is None else int(value))
        elif kind == S.STR:
            data = value.encode("utf-8") if isinstance(value, str) else b""
            out += _U32.pack(len(data)) + data
        elif kind == S.BYTES:
            data = bytes(value) if isinstance(value, (bytes, bytearray, memoryview)) else b""
            out += _U32.pack(len(data)) + data
        elif kind == S.MODE:
            names = S.MODES[:-1]
            out.append(names.index(value) if value in names else len(S.MODES) - 1)
        elif kind == S.STRS:
            items = value if isinstance(value, (list, tuple)) else []
            out += _U32.pack(len(items))
            for item in items:
                data = item.encode("utf-8") if isinstance(item, str) else b""
                out += _U32.pack(len(data)) + data
        elif kind == S.LIST:
            items = value if isinstance(value, (list, tuple)) else []
            out += _U32.pack(len(items))
            for item in items:
                _write_fields(out, sub, item)
        else:  # pragma: no cover - a type the generated table has and this walker does not
            raise WireError(f"field {name}: unknown type {kind}")


def encode(kind: str, obj: Any) -> bytes:
    """`obj` (a dict, as bridge_ops.py builds it) as a message of `kind`, a name in wire.c's table."""
    number, fields = S.KINDS[kind]
    out = bytearray(_U32.pack(S.MAGIC))
    out.append(number)
    _write_fields(out, fields, obj)
    return bytes(out)


class _Reader:
    def __init__(self, data: bytes) -> None:
        self.data = memoryview(data)
        self.at = 0

    def take(self, n: int) -> memoryview:
        if n > len(self.data) - self.at:
            raise WireError("the message ends early")
        piece = self.data[self.at : self.at + n]
        self.at += n
        return piece

    def u8(self) -> int:
        return self.take(1)[0]

    def u32(self) -> int:
        return _U32.unpack(self.take(4))[0]

    def count(self, least_bytes_each: int) -> int:
        # A count the remaining bytes could never hold is refused before any item is read: a
        # four-byte lie must not cost a long walk.
        n = self.u32()
        if n * least_bytes_each > len(self.data) - self.at:
            raise WireError("a list claims more items than the message holds")
        return n


def _least_bytes(fields: tuple) -> int:
    size = {S.BOOL: 1, S.TRI: 1, S.MODE: 1, S.U32: 4, S.OPT: 4, S.I32: 4, S.I64: 8}
    return sum(size.get(kind, 4) for _, kind, _ in fields)


def _read_fields(r: _Reader, fields: tuple) -> dict:
    obj: dict = {}
    for name, kind, sub in fields:
        if kind == S.BOOL:
            obj[name] = r.u8() == 1
        elif kind == S.TRI:
            v = r.u8()
            if v < 2:
                obj[name] = v == 1
        elif kind == S.MODE:
            v = r.u8()
            obj[name] = S.MODES[v] if v < len(S.MODES) else ""
        elif kind == S.U32:
            obj[name] = r.u32()
        elif kind == S.OPT:
            v = r.u32()
            if v != S.NONE:
                obj[name] = v
        elif kind == S.I32:
            v = struct.unpack("<i", r.take(4))[0]
            if v != S.ABSENT:
                obj[name] = v
        elif kind == S.I64:
            obj[name] = _I64.unpack(r.take(8))[0]
        elif kind == S.STR:
            try:
                obj[name] = bytes(r.take(r.u32())).decode("utf-8")
            except UnicodeDecodeError as error:
                raise WireError(f"{name} is not UTF-8") from error
        elif kind == S.BYTES:
            obj[name] = bytes(r.take(r.u32()))
        elif kind == S.STRS:
            items = []
            for _ in range(r.count(4)):
                try:
                    items.append(bytes(r.take(r.u32())).decode("utf-8"))
                except UnicodeDecodeError as error:
                    raise WireError(f"an item of {name} is not UTF-8") from error
            obj[name] = items
        elif kind == S.LIST:
            obj[name] = [_read_fields(r, sub) for _ in range(r.count(_least_bytes(sub)))]
        else:  # pragma: no cover - see _write_fields
            raise WireError(f"field {name}: unknown type {kind}")
    return obj


def decode(kind: str, data: bytes) -> dict:
    """The message of `kind` in `data` as a dict. Raises WireError unless `data` is exactly one whole
    message of that kind: nothing short, nothing left over."""
    number, fields = S.KINDS[kind]
    r = _Reader(data)
    if r.u32() != S.MAGIC:
        raise WireError("not an amgi wire message")
    if r.u8() != number:
        raise WireError(f"not a {kind} message")
    obj = _read_fields(r, fields)
    if r.at != len(r.data):
        raise WireError("bytes left over after the message")
    return obj
