// The protobuf messages amgi exchanges with Gemini over gRPC, and the codec
// that turns them into bytes and back, for the tests' fake Gemini
// (plusaudio/test/helpers/fake-gemini.js), which decodes amgi's requests and
// encodes its answers with it. amgi's own client is C (server/amgi/gemini.c,
// the same messages), so the fake is an independent reading of the wire.
//
// The service is google.ai.generativelanguage.v1beta.GenerativeService
// (googleapis/googleapis, google/ai/generativelanguage/v1beta/
// generative_service.proto and content.proto). Only the fields amgi sends or
// reads are declared below, each with the number the server uses. Messages
// are written as the same camelCase objects the REST API took as JSON, so a
// caller builds a request the way Google's docs show it; the difference is
// that bytes are bytes (Blob.data is a Uint8Array, never base64) and nothing
// on the wire is JSON.
//
// Why a hand-written subset and not generated stubs. The public protos lag
// the live service: as of 2026-11-08 their ThinkingConfig has no
// thinking_level (the googleapis file was last changed 2025-12-18), so stubs
// generated from them could not send the one generation setting amgi uses.
// And a runtime (@grpc/grpc-js plus protobufjs, about 7 MB) would end this
// package's zero-dependency rule for a dozen small messages that
// ../protobuf.js's primitives already encode.
//
// Verified live against generativelanguage.googleapis.com:443 on 2026-11-08:
//   - API key in the `x-goog-api-key` metadata, plain gRPC over HTTP/2.
//   - ThinkingConfig.thinking_level is field 4, an enum with LOW = 1,
//     MEDIUM = 2, HIGH = 3, MINIMAL = 4 (field 4 = 4 is refused by
//     gemini-3.8-flash with "Thinking level MINIMAL is not supported", and
//     field 4 = 3 thought 15 times longer than field 4 = 1). The numbering is
//     Vertex AI's (google/cloud/aiplatform/v1beta1/content.proto), not in
//     generativelanguage's public proto.
//   - GenerationConfig.response_json_schema is field 28 (the REST
//     "responseJsonSchema"), a google.protobuf.Value tree; our draft-07
//     schema goes as is.
//   - Speech: response_modalities [AUDIO] (20) and speech_config (21); the
//     clip comes back in Part.inline_data (3) as raw WAV bytes.
//   - Audio input: Part.inline_data with the WAV bytes.
//   - Errors: grpc-status, grpc-message and grpc-status-details-bin (a
//     google.rpc.Status whose details are Any messages, e.g. an ErrorInfo
//     for a refused key). A spent quota is RESOURCE_EXHAUSTED (8) with a
//     google.rpc.QuotaFailure and RetryInfo in those details, the same
//     messages the REST API rendered as JSON.

import protobuf from "../protobuf.js";

const {
    WIRE_FIXED64,
    WIRE_LENGTH,
    WIRE_VARINT,
    readFieldsLenient,
    readVarint,
    writeBytesField,
    writeDoubleField,
    writeVarint,
    writeVarintField,
} = protobuf;

// ========================
// DESCRIPTORS
// ========================

type Scalar = 'string' | 'bytes' | 'bool' | 'int32' | 'int64' | 'double' | 'value';
interface EnumType { enum: Record<string, number> }
interface MessageType { message: () => Descriptor }
type FieldType = Scalar | EnumType | MessageType;

interface Field {
    n: number;
    type: FieldType;
    repeated?: boolean;
}

export interface Descriptor {
    name: string;
    fields: Record<string, Field>;
}

const message = (descriptor: () => Descriptor): MessageType => ({ message: descriptor });

const MODALITY = { enum: { MODALITY_UNSPECIFIED: 0, TEXT: 1, IMAGE: 2, AUDIO: 3 } };
const THINKING_LEVEL = { enum: { THINKING_LEVEL_UNSPECIFIED: 0, LOW: 1, MEDIUM: 2, HIGH: 3, MINIMAL: 4 } };
const FINISH_REASON = {
    enum: {
        FINISH_REASON_UNSPECIFIED: 0, STOP: 1, MAX_TOKENS: 2, SAFETY: 3, RECITATION: 4, OTHER: 5,
        LANGUAGE: 6, BLOCKLIST: 7, PROHIBITED_CONTENT: 8, SPII: 9, MALFORMED_FUNCTION_CALL: 10,
        IMAGE_SAFETY: 11, UNEXPECTED_TOOL_CALL: 12, TOO_MANY_TOOL_CALLS: 13,
    },
};
const BLOCK_REASON = {
    enum: { BLOCK_REASON_UNSPECIFIED: 0, SAFETY: 1, OTHER: 2, BLOCKLIST: 3, PROHIBITED_CONTENT: 4, IMAGE_SAFETY: 5 },
};

export const Blob: Descriptor = {
    name: 'Blob',
    fields: { mimeType: { n: 1, type: 'string' }, data: { n: 2, type: 'bytes' } },
};

export const Part: Descriptor = {
    name: 'Part',
    fields: {
        text: { n: 2, type: 'string' },
        inlineData: { n: 3, type: message(() => Blob) },
        thought: { n: 11, type: 'bool' },
        // Opaque; sent back only in multi-turn function calling, which amgi
        // does not do. Declared so a decoded part round-trips.
        thoughtSignature: { n: 13, type: 'bytes' },
    },
};

export const Content: Descriptor = {
    name: 'Content',
    fields: { parts: { n: 1, type: message(() => Part), repeated: true }, role: { n: 2, type: 'string' } },
};

const PrebuiltVoiceConfig: Descriptor = { name: 'PrebuiltVoiceConfig', fields: { voiceName: { n: 1, type: 'string' } } };
const VoiceConfig: Descriptor = { name: 'VoiceConfig', fields: { prebuiltVoiceConfig: { n: 1, type: message(() => PrebuiltVoiceConfig) } } };
const SpeechConfig: Descriptor = {
    name: 'SpeechConfig',
    fields: { voiceConfig: { n: 1, type: message(() => VoiceConfig) }, languageCode: { n: 2, type: 'string' } },
};

const ThinkingConfig: Descriptor = {
    name: 'ThinkingConfig',
    fields: {
        includeThoughts: { n: 1, type: 'bool' },
        thinkingBudget: { n: 2, type: 'int32' },
        thinkingLevel: { n: 4, type: THINKING_LEVEL },
    },
};

const GenerationConfig: Descriptor = {
    name: 'GenerationConfig',
    fields: {
        maxOutputTokens: { n: 4, type: 'int32' },
        responseMimeType: { n: 13, type: 'string' },
        responseModalities: { n: 20, type: MODALITY, repeated: true },
        speechConfig: { n: 21, type: message(() => SpeechConfig) },
        thinkingConfig: { n: 22, type: message(() => ThinkingConfig) },
        responseJsonSchema: { n: 28, type: 'value' },
    },
};

export const GenerateContentRequest: Descriptor = {
    name: 'GenerateContentRequest',
    fields: {
        model: { n: 1, type: 'string' },
        contents: { n: 2, type: message(() => Content), repeated: true },
        generationConfig: { n: 4, type: message(() => GenerationConfig) },
        systemInstruction: { n: 8, type: message(() => Content) },
    },
};

const Candidate: Descriptor = {
    name: 'Candidate',
    fields: {
        content: { n: 1, type: message(() => Content) },
        finishReason: { n: 2, type: FINISH_REASON },
        index: { n: 3, type: 'int32' },
        finishMessage: { n: 4, type: 'string' },
    },
};

const PromptFeedback: Descriptor = { name: 'PromptFeedback', fields: { blockReason: { n: 1, type: BLOCK_REASON } } };

const UsageMetadata: Descriptor = {
    name: 'UsageMetadata',
    fields: {
        promptTokenCount: { n: 1, type: 'int32' },
        candidatesTokenCount: { n: 2, type: 'int32' },
        totalTokenCount: { n: 3, type: 'int32' },
        cachedContentTokenCount: { n: 4, type: 'int32' },
        thoughtsTokenCount: { n: 10, type: 'int32' },
    },
};

export const GenerateContentResponse: Descriptor = {
    name: 'GenerateContentResponse',
    fields: {
        candidates: { n: 1, type: message(() => Candidate), repeated: true },
        promptFeedback: { n: 2, type: message(() => PromptFeedback) },
        usageMetadata: { n: 3, type: message(() => UsageMetadata) },
        modelVersion: { n: 4, type: 'string' },
        responseId: { n: 5, type: 'string' },
    },
};

// google/rpc/status.proto and google/rpc/error_details.proto.

const Any: Descriptor = { name: 'Any', fields: { typeUrl: { n: 1, type: 'string' }, value: { n: 2, type: 'bytes' } } };

export const Status: Descriptor = {
    name: 'Status',
    fields: {
        code: { n: 1, type: 'int32' },
        message: { n: 2, type: 'string' },
        details: { n: 3, type: message(() => Any), repeated: true },
    },
};

const Violation: Descriptor = {
    name: 'QuotaFailure.Violation',
    fields: {
        subject: { n: 1, type: 'string' },
        description: { n: 2, type: 'string' },
        apiService: { n: 3, type: 'string' },
        quotaMetric: { n: 4, type: 'string' },
        quotaId: { n: 5, type: 'string' },
        quotaValue: { n: 7, type: 'int64' },
    },
};

export const QuotaFailure: Descriptor = { name: 'QuotaFailure', fields: { violations: { n: 1, type: message(() => Violation), repeated: true } } };

const Duration: Descriptor = { name: 'Duration', fields: { seconds: { n: 1, type: 'int64' }, nanos: { n: 2, type: 'int32' } } };

export const RetryInfo: Descriptor = { name: 'RetryInfo', fields: { retryDelay: { n: 1, type: message(() => Duration) } } };

export const ErrorInfo: Descriptor = { name: 'ErrorInfo', fields: { reason: { n: 1, type: 'string' }, domain: { n: 2, type: 'string' } } };

export const TYPE_URL_PREFIX = 'type.googleapis.com/google.rpc.';

// ========================
// ENCODING
// ========================

// deno-lint-ignore no-explicit-any
type Message = Record<string, any>;

const isEnum = (type: FieldType): type is EnumType => typeof type === 'object' && 'enum' in type;
const isMessage = (type: FieldType): type is MessageType => typeof type === 'object' && 'message' in type;
const isVarint = (type: FieldType) => type === 'bool' || type === 'int32' || type === 'int64' || isEnum(type);

function enumNumber(type: EnumType, value: unknown, where: string): number {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    // The enum's own names, exactly ("LOW", "AUDIO"): one spelling, so a
    // request and what a test decodes from it read the same.
    const number = typeof value === 'string' && Object.hasOwn(type.enum, value) ? type.enum[value] : undefined;
    if (number === undefined) throw new Error(`${where}: ${typeof value === 'string' ? `"${value}"` : String(value)} is not one of ${Object.keys(type.enum).join(', ')}`);
    return number;
}

function varintOf(type: FieldType, value: unknown, where: string): number {
    if (type === 'bool') {
        if (typeof value !== 'boolean') throw new Error(`${where} must be a boolean`);
        return value ? 1 : 0;
    }
    if (isEnum(type)) return enumNumber(type, value, where);
    // Negative int32/int64 would need ten-byte two's complement; nothing amgi
    // sends or reads is negative, so it is refused rather than half supported.
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${where} must be a non-negative integer`);
    }
    return value;
}

/** google.protobuf.Value, from any JSON-shaped JS value. */
export function encodeValue(value: unknown, where = 'Value'): Buffer {
    if (value === null) return writeVarintField(1, 0);
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`${where}: ${value} has no protobuf Value`);
        return writeDoubleField(2, value);
    }
    if (typeof value === 'string') return writeBytesField(3, Buffer.from(value, 'utf8'));
    if (typeof value === 'boolean') return writeVarintField(4, value ? 1 : 0);
    if (Array.isArray(value)) {
        return writeBytesField(6, Buffer.concat(value.map((item, i) => writeBytesField(1, encodeValue(item, `${where}[${i}]`)))));
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
        return writeBytesField(5, Buffer.concat(entries.map(([key, item]) =>
            writeBytesField(1, Buffer.concat([writeBytesField(1, Buffer.from(key, 'utf8')), writeBytesField(2, encodeValue(item, `${where}.${key}`))])))));
    }
    throw new Error(`${where}: a ${typeof value} has no protobuf Value`);
}

function encodeSingle(field: Field, value: unknown, where: string): Buffer {
    const { n, type } = field;
    if (isMessage(type)) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object`);
        return writeBytesField(n, encode(type.message(), value as Message, where));
    }
    if (isVarint(type)) return writeVarintField(n, varintOf(type, value, where));
    switch (type) {
        case 'string':
            if (typeof value !== 'string') throw new Error(`${where} must be a string`);
            return writeBytesField(n, Buffer.from(value, 'utf8'));
        case 'bytes':
            // Raw bytes only: a base64 string here would be sent as its
            // characters, which is exactly the JSON habit this module ends.
            if (!(value instanceof Uint8Array)) throw new Error(`${where} must be bytes (a Uint8Array), not ${typeof value}`);
            return writeBytesField(n, Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        case 'double':
            if (typeof value !== 'number') throw new Error(`${where} must be a number`);
            return writeDoubleField(n, value);
        case 'value':
            return writeBytesField(n, encodeValue(value, where));
    }
    throw new Error(`${where}: unsupported field type`);
}

/**
 * One message's bytes. A key the descriptor does not declare is an error, not
 * silently dropped: a field the server never receives is a bug that would
 * otherwise only show up as a model ignoring a setting.
 */
export function encode(descriptor: Descriptor, value: Message, where = descriptor.name): Buffer {
    const present: Array<[string, Field, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        const field = descriptor.fields[key];
        if (!field) throw new Error(`${where}.${key} is not a field amgi sends (add it to geminiWire.ts's ${descriptor.name})`);
        present.push([key, field, item]);
    }
    // In field-number order, as protobuf's own serializers write: the same
    // message is the same bytes whatever order its keys were set in.
    present.sort((a, b) => a[1].n - b[1].n);
    const out: Buffer[] = [];
    for (const [key, field, item] of present) {
        const at = `${where}.${key}`;
        if (!field.repeated) {
            out.push(encodeSingle(field, item, at));
            continue;
        }
        if (!Array.isArray(item)) throw new Error(`${at} must be an array`);
        if (isVarint(field.type)) {
            // proto3 packs repeated scalars into one length-delimited field.
            if (item.length) out.push(writeBytesField(field.n, Buffer.concat(item.map((x, i) => writeVarint(varintOf(field.type, x, `${at}[${i}]`))))));
        } else {
            item.forEach((x, i) => out.push(encodeSingle(field, x, `${at}[${i}]`)));
        }
    }
    return Buffer.concat(out);
}

// ========================
// DECODING
// ========================

const byNumberCache = new WeakMap<Descriptor, { byNumber: Map<number, [string, Field]>; varints: Set<number> }>();

function indexOf(descriptor: Descriptor) {
    let index = byNumberCache.get(descriptor);
    if (!index) {
        const byNumber = new Map<number, [string, Field]>();
        const varints = new Set<number>();
        for (const [key, field] of Object.entries(descriptor.fields)) {
            byNumber.set(field.n, [key, field]);
            if (isVarint(field.type)) varints.add(field.n);
        }
        index = { byNumber, varints };
        byNumberCache.set(descriptor, index);
    }
    return index;
}

function enumName(type: EnumType, number: number): string | number {
    for (const [name, value] of Object.entries(type.enum)) if (value === number) return name;
    return number;
}

function scalarFromVarint(type: FieldType, number: number): unknown {
    if (type === 'bool') return number !== 0;
    if (isEnum(type)) return enumName(type, number);
    return number;
}

function unpackVarints(bytes: Uint8Array): number[] {
    const out: number[] = [];
    for (let at = 0; at < bytes.length;) {
        const { value, next } = readVarint(bytes, at);
        out.push(value);
        at = next;
    }
    return out;
}

/** A google.protobuf.Value back into the JS value it stands for. */
export function decodeValue(bytes: Uint8Array): unknown {
    let result: unknown = null;
    for (const field of readFieldsLenient(bytes, new Set([1, 4]))) {
        if (field.number === 1) result = null;
        else if (field.number === 2 && field.wireType === WIRE_FIXED64) result = Buffer.from(field.bytes).readDoubleLE(0);
        else if (field.number === 3 && field.wireType === WIRE_LENGTH) result = Buffer.from(field.bytes).toString('utf8');
        else if (field.number === 4) result = field.value !== 0;
        else if (field.number === 5 && field.wireType === WIRE_LENGTH) {
            const struct: Record<string, unknown> = {};
            for (const entry of readFieldsLenient(field.bytes, new Set())) {
                if (entry.number !== 1 || entry.wireType !== WIRE_LENGTH) continue;
                let key = '';
                let item: unknown = null;
                for (const part of readFieldsLenient(entry.bytes, new Set())) {
                    if (part.number === 1) key = Buffer.from(part.bytes).toString('utf8');
                    else if (part.number === 2) item = decodeValue(part.bytes);
                }
                struct[key] = item;
            }
            result = struct;
        } else if (field.number === 6 && field.wireType === WIRE_LENGTH) {
            const list: unknown[] = [];
            for (const entry of readFieldsLenient(field.bytes, new Set())) {
                if (entry.number === 1 && entry.wireType === WIRE_LENGTH) list.push(decodeValue(entry.bytes));
            }
            result = list;
        }
    }
    return result;
}

function wireTypeName(wireType: number) {
    return ({ 0: 'varint', 1: 'fixed64', 2: 'length-delimited', 5: 'fixed32' } as Record<number, string>)[wireType] ?? String(wireType);
}

/**
 * One message back into the camelCase object it was written from. Fields the
 * descriptor does not know are skipped (the server adds fields all the time);
 * a known field in an unexpected wire type means the bytes are not what we
 * think they are, and throws.
 */
export function decode(descriptor: Descriptor, bytes: Uint8Array): Message {
    const { byNumber, varints } = indexOf(descriptor);
    const out: Message = {};
    for (const wire of readFieldsLenient(bytes, varints)) {
        const known = byNumber.get(wire.number);
        if (!known) continue;
        const [key, field] = known;
        const { type } = field;
        const mismatch = () => new Error(`${descriptor.name}.${key}: unexpected ${wireTypeName(wire.wireType)} field`);

        let values: unknown[];
        if (isVarint(type)) {
            if (wire.wireType === WIRE_VARINT) values = [scalarFromVarint(type, wire.value)];
            else if (wire.wireType === WIRE_LENGTH && field.repeated) values = unpackVarints(wire.bytes).map((n) => scalarFromVarint(type, n));
            else throw mismatch();
        } else if (type === 'double') {
            if (wire.wireType !== WIRE_FIXED64) throw mismatch();
            values = [Buffer.from(wire.bytes).readDoubleLE(0)];
        } else {
            if (wire.wireType !== WIRE_LENGTH) throw mismatch();
            if (isMessage(type)) values = [decode(type.message(), wire.bytes)];
            else if (type === 'string') values = [Buffer.from(wire.bytes).toString('utf8')];
            else if (type === 'bytes') values = [new Uint8Array(wire.bytes.buffer, wire.bytes.byteOffset, wire.bytes.byteLength)];
            else values = [decodeValue(wire.bytes)];
        }

        if (field.repeated) out[key] = [...(out[key] ?? []), ...values];
        else out[key] = values[values.length - 1];
    }
    return out;
}

// ========================
// gRPC FRAMING AND STATUS
// ========================

/** A message as gRPC sends it: an uncompressed flag byte, a 4-byte big-endian length, the bytes. */
export function frame(bytes: Uint8Array): Buffer {
    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(bytes.length, 1);
    return Buffer.concat([prefix, bytes]);
}

/** The messages in a gRPC body. Compressed messages are refused: amgi never offers grpc-accept-encoding. */
export function unframe(body: Uint8Array): Uint8Array[] {
    const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    const messages: Uint8Array[] = [];
    for (let at = 0; at < buffer.length;) {
        if (at + 5 > buffer.length) throw new Error('truncated gRPC message prefix');
        if (buffer[at] !== 0) throw new Error('compressed gRPC message, which was not asked for');
        const length = buffer.readUInt32BE(at + 1);
        if (at + 5 + length > buffer.length) throw new Error('truncated gRPC message');
        messages.push(buffer.subarray(at + 5, at + 5 + length));
        at += 5 + length;
    }
    return messages;
}

/** google.rpc.Code, by number. */
export const GRPC_CODES = [
    'OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS',
    'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE',
    'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
] as const;

export const RESOURCE_EXHAUSTED = 8;

/**
 * The codes a retry cannot fix: those google.rpc.Code maps to an HTTP 4xx
 * (code.proto's own table). The REST client treated every 4xx but 429 as
 * fatal and every 5xx as retryable; this keeps exactly that split.
 */
export const FATAL_CODES = new Set([1, 3, 5, 6, 7, 9, 10, 11, 16]);

/** What a google.rpc.Status's details say about quotas, already decoded. */
export interface StatusDetails {
    violations: Array<{ quotaId?: string; quotaMetric?: string; quotaValue?: number }>;
    /** RetryInfo's retry_delay in milliseconds, when one was sent. */
    retryDelayMs: number | null;
}

/** grpc-status-details-bin (base64 of a google.rpc.Status) -> the quota details amgi reads. */
export function statusDetails(detailsBin: string | undefined): StatusDetails {
    const result: StatusDetails = { violations: [], retryDelayMs: null };
    if (!detailsBin) return result;
    let status: Message;
    try {
        status = decode(Status, Buffer.from(detailsBin, 'base64'));
    } catch {
        return result;
    }
    for (const any of status.details ?? []) {
        if (any.typeUrl === `${TYPE_URL_PREFIX}QuotaFailure`) {
            result.violations.push(...(decode(QuotaFailure, any.value).violations ?? []));
        } else if (any.typeUrl === `${TYPE_URL_PREFIX}RetryInfo`) {
            const delay = decode(RetryInfo, any.value).retryDelay ?? {};
            result.retryDelayMs = Math.ceil((delay.seconds ?? 0) * 1000 + (delay.nanos ?? 0) / 1e6);
        }
    }
    return result;
}

/** A google.rpc.Status with typed details, as grpc-status-details-bin carries it (for fakes and tests). */
export function encodeStatus(status: { code: number; message?: string; details?: Array<{ type: 'QuotaFailure' | 'RetryInfo' | 'ErrorInfo'; value: Message }> }): string {
    const descriptors = { QuotaFailure, RetryInfo, ErrorInfo };
    const bytes = encode(Status, {
        code: status.code,
        ...(status.message ? { message: status.message } : {}),
        details: (status.details ?? []).map((detail) => ({
            typeUrl: `${TYPE_URL_PREFIX}${detail.type}`,
            value: encode(descriptors[detail.type], detail.value),
        })),
    });
    return bytes.toString('base64');
}

export const GENERATE_CONTENT_PATH = '/google.ai.generativelanguage.v1beta.GenerativeService/GenerateContent';
