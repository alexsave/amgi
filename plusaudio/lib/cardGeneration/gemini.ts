// The one client amgi uses for every model call: card text, speech,
// transcription and the audio judge all go to Google's Gemini API through
// GenerateContent, with one API key (GEMINI_API_KEY). It owns the request,
// the rate-limit and quota handling, and the error messages a person sees;
// the callers (cardGeneration.ts, geminiSpeech.ts) own only what they ask.
//
// The transport is gRPC over Node's own node:http2, with the protobuf
// messages in geminiWire.ts: no JSON on the wire in either direction, and
// audio travels as raw bytes rather than base64. No package is needed for it.
//
// Like the rest of cardGeneration/, this module reads no environment variable
// and owns no global state: the key, the endpoint and the clock's sleep are
// injected, so a test points it at an in-process fake gRPC server
// (tests/server/plusaudio/helpers/fake-gemini.js) and never reaches the network.
//
// What the API does, as verified live on 2026-11-07/08 (the wire details are
// in geminiWire.ts):
//   GenerativeService/GenerateContent at generativelanguage.googleapis.com:443,
//   metadata x-goog-api-key. Structured output: generationConfig
//   .responseMimeType "application/json" plus generationConfig
//   .responseJsonSchema, which takes our draft-07 JSON Schema as written
//   ($schema, enum, additionalProperties). Thinking:
//   generationConfig.thinkingConfig.thinkingLevel; gemini-3.8-flash accepts
//   LOW | MEDIUM | HIGH (default MEDIUM) and refuses MINIMAL
//   (INVALID_ARGUMENT). Thought parts come back flagged `thought: true`.
//   A spent quota is RESOURCE_EXHAUSTED with a google.rpc.QuotaFailure whose
//   quotaId names the window (…PerDay… or …PerMinute…) and a RetryInfo.

import http2 from "node:http2";
import { GEMINI_KEY_PAGE, MISSING_KEY_MESSAGE } from "../geminiKey.js";
import { createRateGate } from "../rateGate.js";
import {
    FATAL_CODES,
    GENERATE_CONTENT_PATH,
    GRPC_CODES,
    GenerateContentRequest as RequestMessage,
    GenerateContentResponse as ResponseMessage,
    RESOURCE_EXHAUSTED,
    decode,
    encode,
    frame,
    statusDetails,
    unframe,
} from "./geminiWire.ts";
import type { StatusDetails } from "./geminiWire.ts";

export interface GeminiPart {
    text?: string;
    thought?: boolean;
    /** Raw bytes both ways: an audio clip sent to be judged, a clip that came back. */
    inlineData?: { mimeType?: string; data?: Uint8Array };
}

export interface GenerateContentResponse {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string; content?: { parts?: GeminiPart[] } }>;
    usageMetadata?: Record<string, unknown>;
}

/**
 * The request, built by each caller in the camelCase shape of Google's docs
 * and encoded field by field (geminiWire.ts's GenerateContentRequest); a
 * field that schema does not declare is refused, never silently dropped.
 */
// deno-lint-ignore no-explicit-any
export type GenerateContentRequest = Record<string, any>;

export interface GeminiClient {
    generateContent(model: string, request: GenerateContentRequest): Promise<GenerateContentResponse>;
}

export interface GeminiClientOptions {
    apiKey: string;
    /**
     * Defaults to Google's endpoint. Overridden only by tests and the e2e
     * fake server; an http:// address is spoken to as cleartext HTTP/2.
     */
    baseUrl?: string;
    sleep?: (ms: number) => Promise<void>;
    /** The most a per-minute rate limit may make one request wait, in total. */
    maxRateLimitWaitMs?: number;
    requestTimeoutMs?: number;
    /**
     * The rate gate every request passes (plusaudio/lib/rateGate.js, or its
     * parent-owned form, ipcGate.js). Asked before each request how long to
     * wait, and told after each answer whether it was refused. Defaults to a
     * gate of this client's own; the app and the CLIs pass the process's.
     */
    gate?: RateGate;
}

/** What the client needs from a rate gate; acquire may answer asynchronously (over IPC). */
export interface RateGate {
    acquire(model: string): number | Promise<number>;
    record(model: string, outcome: 'ok' | 'rateLimited', retryDelayMs?: number | null): void;
}

/**
 * A failure no retry can fix: the day's quota is spent, the key is refused,
 * the request is malformed, the text is blocked. generateCardAudio rethrows
 * these at once instead of spending its remaining attempts (and the
 * remaining quota) on them, and the message is shown to the person verbatim,
 * so it is one line and says what to do.
 */
export class GeminiUnavailableError extends Error {
    readonly fatal = true;
    constructor(message: string) {
        super(message);
        this.name = 'GeminiUnavailableError';
    }
}

/**
 * A per-minute rate limit that asked for a longer wait than this client will
 * sit through on its own (maxRateLimitWaitMs). Not fatal - it passes - and
 * not a verdict on the request either, so it is never retried in place: it
 * is carried out to whoever can wait without holding a request open (the
 * bulk add screen waits, shows a countdown and tries the line again). Its
 * message is one line, for whoever shows it as is.
 */
export class GeminiRateLimitError extends Error {
    readonly rateLimited = true;
    readonly retryAfterMs: number;
    constructor(model: string, retryAfterMs: number) {
        super(`Gemini is limiting how many requests ${model} takes per minute and asked to wait ${Math.ceil(retryAfterMs / 1000)}s.`);
        this.name = 'GeminiRateLimitError';
        this.retryAfterMs = retryAfterMs;
    }
}

/** Whether `error` is a per-minute limit to wait out (GeminiRateLimitError, or one rebuilt across a process boundary). */
export function isRateLimited(error: unknown): error is { rateLimited: true; retryAfterMs: number; message: string } {
    return (error as { rateLimited?: boolean })?.rateLimited === true;
}

/** A per-day cap: fatal like any GeminiUnavailableError, and marked so a bulk run can stop its whole queue at once. */
export class GeminiDailyCapError extends GeminiUnavailableError {
    readonly dailyCap = true;
    constructor(message: string) {
        super(message);
        this.name = 'GeminiDailyCapError';
    }
}

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';
export { GEMINI_KEY_PAGE, MISSING_KEY_MESSAGE };

/** What a per-day quota refusal says about the limit it hit. */
export interface DailyQuota {
    /** quotaId ends in "-FreeTier" (an unbilled project) rather than naming a paid tier. */
    freeTier: boolean;
    /** The day's request limit (QuotaFailure's quotaValue), when Google says. */
    limit?: number;
    /** How long until it resets (RetryInfo's retryDelay), when Google says. */
    resetsInMs?: number;
}

/**
 * The message a spent daily quota surfaces as, word for word, in the
 * add-card row. Built from what the refusal itself says, because the two
 * cases need different advice: an unbilled project's free tier (10 requests
 * per day per model) is lifted by enabling billing, while a billed project
 * has a daily cap of its own (100 per day per model on Tier 1 for
 * gemini-3.8-flash-tts, seen live 2026-11-08) that only time or a higher
 * usage tier lifts - telling that person to "enable billing" would be wrong.
 */
export function dailyQuotaMessage(model: string, quota: DailyQuota = { freeTier: true }): string {
    if (quota.freeTier) {
        return `Gemini's free tier allows ${quota.limit ?? 10} requests per day per model, and today's are used up for ${model}. ` +
            `Enable billing for your Gemini API key's project in Google AI Studio (${GEMINI_KEY_PAGE}) to lift the limit, or try again tomorrow.`;
    }
    const resets = quota.resetsInMs !== undefined ? ` It resets in about ${Math.max(1, Math.round(quota.resetsInMs / 3_600_000))} hour(s).` : '';
    const limit = quota.limit !== undefined ? ` of ${quota.limit} requests` : '';
    return `Your Gemini project's daily limit${limit} for ${model} is used up.${resets} ` +
        `A higher usage tier raises it (Google AI Studio, ${GEMINI_KEY_PAGE}).`;
}

/**
 * The per-day limit a quota refusal reports, or null when it is some other
 * limit (per minute, unlabelled) that can be waited out briefly.
 */
function dailyQuotaOf(details: StatusDetails): DailyQuota | null {
    const violation = details.violations.find((v) =>
        /PerDay/i.test(v.quotaId || '') || /per_day|PerDay/i.test(v.quotaMetric || ''));
    if (!violation) return null;
    const limit = Number(violation.quotaValue);
    return {
        freeTier: /FreeTier/i.test(violation.quotaId || ''),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(details.retryDelayMs !== null ? { resetsInMs: details.retryDelayMs } : {}),
    };
}

// ========================
// TRANSPORT
// ========================

/** One unary call's outcome: the HTTP status, the gRPC status and whatever messages came back. */
interface UnaryReply {
    httpStatus: number;
    /** grpc-status; null when the server sent none (not a gRPC answer). */
    code: number | null;
    message: string;
    detailsBin?: string;
    messages: Uint8Array[];
}

/** How long an unused connection stays open for the next request before it is closed. */
const IDLE_CLOSE_MS = 30_000;

/**
 * One HTTP/2 connection per client, opened on first use and reused by every
 * request after it. It holds the process open only while a request is in
 * flight (ref/unref), so a CLI exits as soon as its work is done, and it is
 * dropped and replaced after an error, a GOAWAY or a long idle.
 */
function createChannel(origin: string) {
    let session: http2.ClientHttp2Session | null = null;
    let inFlight = 0;
    // What each call in flight on a session does if that session fails. The
    // session has one 'error' listener that runs them all: a listener per
    // call would pass Node's ten-listener warning at the eleventh.
    const failing = new WeakMap<http2.ClientHttp2Session, Set<(error: Error) => void>>();

    function current(): http2.ClientHttp2Session {
        if (session && !session.closed && !session.destroyed) return session;
        const opened = http2.connect(origin);
        const forget = () => {
            if (session === opened) session = null;
        };
        const calls = new Set<(error: Error) => void>();
        failing.set(opened, calls);
        // Most failures arrive on the request's own stream; this one listener
        // also keeps an unhandled 'error' from crashing the process.
        opened.on('error', (error: Error) => {
            forget();
            for (const fail of [...calls]) fail(error);
        });
        opened.on('goaway', forget);
        opened.on('close', forget);
        opened.setTimeout(IDLE_CLOSE_MS, () => {
            if (inFlight === 0) opened.close();
        });
        session = opened;
        return opened;
    }

    function call(path: string, body: Uint8Array, metadata: Record<string, string>, timeoutMs: number): Promise<UnaryReply> {
        return new Promise((resolve, reject) => {
            const active = current();
            const calls = failing.get(active)!;
            inFlight += 1;
            active.ref();
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (fn: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                calls.delete(onSessionError);
                inFlight -= 1;
                if (inFlight === 0 && !active.destroyed) active.unref();
                fn();
            };
            const onSessionError = (error: Error) => finish(() => reject(error));
            calls.add(onSessionError);

            let stream: http2.ClientHttp2Stream;
            try {
                stream = active.request({
                    ':method': 'POST',
                    ':path': path,
                    'content-type': 'application/grpc',
                    te: 'trailers',
                    'grpc-timeout': `${Math.max(1, Math.ceil(timeoutMs))}m`,
                    ...metadata,
                });
            } catch (error) {
                finish(() => reject(error));
                return;
            }
            timer = setTimeout(() => {
                stream.close(http2.constants.NGHTTP2_CANCEL);
                finish(() => reject(new Error(`no answer within ${timeoutMs} ms`)));
            }, timeoutMs);

            const chunks: Buffer[] = [];
            let headers: http2.IncomingHttpHeaders = {};
            let trailers: http2.IncomingHttpHeaders = {};
            stream.on('response', (h) => { headers = h; });
            stream.on('trailers', (t) => { trailers = t; });
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', (error) => finish(() => reject(error)));
            stream.on('close', () => finish(() => {
                // A trailers-only answer (every error) carries its status in
                // the headers; a normal one in the trailers after the body.
                const all = { ...headers, ...trailers };
                const status = all['grpc-status'];
                const rawMessage = String(all['grpc-message'] ?? '');
                let message = rawMessage;
                try {
                    message = decodeURIComponent(rawMessage);
                } catch { /* not percent-encoded after all */ }
                const httpStatus = Number(headers[':status'] ?? 0);
                if (status === undefined && httpStatus === 0) {
                    reject(new Error(`the stream closed without an answer (HTTP/2 code ${stream.rstCode})`));
                    return;
                }
                // Without a grpc-status the body is not gRPC (a proxy's error
                // page, say), and only the HTTP status is worth reading.
                let messages: Uint8Array[] = [];
                if (status !== undefined) {
                    try {
                        messages = unframe(Buffer.concat(chunks));
                    } catch (error) {
                        reject(error);
                        return;
                    }
                }
                const detailsBin = all['grpc-status-details-bin'];
                resolve({
                    httpStatus,
                    code: status === undefined ? null : Number(status),
                    message,
                    ...(typeof detailsBin === 'string' ? { detailsBin } : {}),
                    messages,
                });
            }));
            stream.end(frame(body));
        });
    }

    return { call };
}

export function createGeminiClient(options: GeminiClientOptions): GeminiClient {
    const {
        apiKey,
        baseUrl = GEMINI_API_BASE,
        sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        maxRateLimitWaitMs = 30_000,
        requestTimeoutMs = 60_000,
        gate = createRateGate(),
    } = options;

    if (!apiKey) throw new GeminiUnavailableError(MISSING_KEY_MESSAGE);
    const channel = createChannel(new URL(baseUrl).origin);

    async function generateContent(model: string, request: GenerateContentRequest): Promise<GenerateContentResponse> {
        // Encoded once, before any wait: a request amgi cannot express on the
        // wire is a bug, and fails here without costing a request.
        const body = encode(RequestMessage, { model: `models/${model}`, ...request });
        let waitedMs = 0;

        for (;;) {
            // The gate decides when this request may go: at once, after a
            // block from an earlier refusal (this card's or any other's), or
            // once the learned per-minute window has room. A short wait is
            // cheaper to sit through here than to hand back; a long one is
            // handed back, typed and carrying the gate's own jittered wait,
            // so nothing holds a request (and, in the app, a generator
            // subprocess) open for a minute.
            const waitMs = await gate.acquire(model);
            if (waitMs > 0) {
                if (waitedMs + waitMs > maxRateLimitWaitMs) throw new GeminiRateLimitError(model, waitMs);
                await sleep(waitMs);
                waitedMs += waitMs;
                continue;
            }

            let reply: UnaryReply;
            try {
                reply = await channel.call(GENERATE_CONTENT_PATH, body, { 'x-goog-api-key': apiKey }, requestTimeoutMs);
            } catch (error) {
                // Connection refused, reset, timed out: retryable, like a
                // network error was under fetch.
                throw new Error(`Gemini request to ${model} failed: ${(error as Error).message}`);
            }

            if (reply.code === RESOURCE_EXHAUSTED || (reply.code === null && reply.httpStatus === 429)) {
                const details = statusDetails(reply.detailsBin);
                const daily = dailyQuotaOf(details);
                if (daily) throw new GeminiDailyCapError(dailyQuotaMessage(model, daily));
                // A per-minute refusal is news for every request sharing
                // this key: the gate learns from it (block, doubling, a
                // lower cap) and the next acquire above says how long.
                gate.record(model, 'rateLimited', details.retryDelayMs);
                continue;
            }

            if (reply.code === null) {
                // Not a gRPC answer at all (a proxy, a wrong endpoint): judged
                // by its HTTP status the way the REST client judged it.
                const summary = `Gemini request to ${model} failed (HTTP ${reply.httpStatus})`;
                if (reply.httpStatus >= 400 && reply.httpStatus < 500) throw new GeminiUnavailableError(summary);
                throw new Error(summary);
            }

            if (reply.code !== 0) {
                const message = reply.message.replace(/\s+/g, ' ').trim().slice(0, 300);
                const summary = `Gemini request to ${model} failed (${GRPC_CODES[reply.code] ?? `gRPC ${reply.code}`})${message ? `: ${message}` : ''}`;
                // A refused key, a bad request or an unknown model fails the
                // same way on every retry; a server error might not.
                if (FATAL_CODES.has(reply.code)) throw new GeminiUnavailableError(summary);
                throw new Error(summary);
            }

            if (reply.messages.length !== 1) throw new Error(`Gemini (${model}) answered with ${reply.messages.length} messages instead of one`);
            let data: GenerateContentResponse;
            try {
                data = decode(ResponseMessage, reply.messages[0]) as GenerateContentResponse;
            } catch (error) {
                throw new Error(`Gemini (${model}) returned a response that does not decode: ${(error as Error).message}`);
            }
            gate.record(model, 'ok');
            const blockReason = data.promptFeedback?.blockReason;
            if (blockReason) throw new GeminiUnavailableError(`Gemini refused this request (${blockReason}).`);
            return data;
        }
    }

    return { generateContent };
}

/** The answer's text, without the model's thought parts. Empty when there is none. */
export function responseText(response: GenerateContentResponse): string {
    const parts = response.candidates?.[0]?.content?.parts ?? [];
    return parts.filter((part) => !part.thought && typeof part.text === 'string').map((part) => part.text).join('').trim();
}
