// The one HTTP client amgi uses for every model call: card text, speech,
// transcription and the audio judge all go to Google's Gemini API through
// generateContent, with one API key (GEMINI_API_KEY). It owns the request,
// the rate-limit and quota handling, and the error messages a person sees;
// the callers (cardGeneration.ts, geminiSpeech.ts) own only what they ask.
//
// Like the rest of cardGeneration/, this module reads no environment variable
// and owns no global state: the key, the base URL, fetch and the clock's sleep
// are injected, so a test drives it with a fake fetch and never reaches the
// network.
//
// What the API does, as verified live on 2026-11-07/08:
//   POST {base}/v1beta/models/{model}:generateContent, header x-goog-api-key.
//   Structured output: generationConfig.responseMimeType "application/json"
//   plus generationConfig.responseJsonSchema, which takes our draft-07 JSON
//   Schema as written ($schema, enum, additionalProperties). Thinking:
//   generationConfig.thinkingConfig.thinkingLevel; gemini-3.8-flash accepts
//   "low" | "medium" | "high" (default medium) and answers HTTP 400 to
//   "minimal". Thought parts come back flagged `thought: true`.
//   A spent free-tier quota is HTTP 429 with a google.rpc.QuotaFailure whose
//   quotaId names the window (…PerDay… or …PerMinute…) and a RetryInfo.

import { GEMINI_KEY_PAGE, MISSING_KEY_MESSAGE } from "../geminiKey.js";
import { createRateGate } from "../rateGate.js";

type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
}>;

export interface GeminiPart {
    text?: string;
    thought?: boolean;
    inlineData?: { mimeType?: string; data?: string };
}

export interface GenerateContentResponse {
    promptFeedback?: { blockReason?: string };
    candidates?: Array<{ finishReason?: string; content?: { parts?: GeminiPart[] } }>;
    usageMetadata?: Record<string, unknown>;
}

/** The request body; built by each caller, sent as is. */
// deno-lint-ignore no-explicit-any
export type GenerateContentRequest = Record<string, any>;

export interface GeminiClient {
    generateContent(model: string, request: GenerateContentRequest): Promise<GenerateContentResponse>;
}

export interface GeminiClientOptions {
    apiKey: string;
    fetch?: FetchLike;
    /** Defaults to Google's endpoint. Overridden only by tests and the e2e fake server. */
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

/** What a per-day 429 says about the limit it hit. */
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
 * add-card row. Built from what the 429 itself says, because the two cases
 * need different advice: an unbilled project's free tier (10 requests per
 * day per model) is lifted by enabling billing, while a billed project has a
 * daily cap of its own (100 per day per model on Tier 1 for
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

interface GoogleErrorDetail {
    '@type'?: string;
    violations?: Array<{ quotaId?: string; quotaMetric?: string; quotaValue?: string }>;
    retryDelay?: string;
}

interface GoogleErrorBody {
    error?: { code?: number; message?: string; status?: string; details?: GoogleErrorDetail[] };
}

function parseErrorBody(text: string): GoogleErrorBody {
    try {
        return JSON.parse(text) as GoogleErrorBody;
    } catch {
        return {};
    }
}

/** "23s" / "1.5s" -> milliseconds, or null. */
function parseRetryDelay(value: string | undefined): number | null {
    const match = /^(\d+(?:\.\d+)?)s$/.exec((value || '').trim());
    return match ? Math.ceil(Number(match[1]) * 1000) : null;
}

/**
 * The per-day limit a 429 reports, or null when it is some other limit (per
 * minute, unlabelled) that can be waited out briefly.
 */
function dailyQuotaOf(details: GoogleErrorDetail[]): DailyQuota | null {
    const violation = details.flatMap((detail) => detail.violations || []).find((v) =>
        /PerDay/i.test(v.quotaId || '') || /per_day|PerDay/i.test(v.quotaMetric || ''));
    if (!violation) return null;
    const limit = Number(violation.quotaValue);
    const retryInfo = details.find((detail) => detail.retryDelay !== undefined);
    const resetsInMs = parseRetryDelay(retryInfo?.retryDelay);
    return {
        freeTier: /FreeTier/i.test(violation.quotaId || ''),
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(resetsInMs !== null ? { resetsInMs } : {}),
    };
}

export function createGeminiClient(options: GeminiClientOptions): GeminiClient {
    const {
        apiKey,
        fetch: fetchImpl = globalThis.fetch as unknown as FetchLike,
        baseUrl = GEMINI_API_BASE,
        sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        maxRateLimitWaitMs = 30_000,
        requestTimeoutMs = 60_000,
        gate = createRateGate(),
    } = options;

    if (!apiKey) throw new GeminiUnavailableError(MISSING_KEY_MESSAGE);
    const base = baseUrl.replace(/\/+$/, '');

    async function generateContent(model: string, request: GenerateContentRequest): Promise<GenerateContentResponse> {
        const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const body = JSON.stringify(request);
        let waitedMs = 0;

        for (;;) {
            // The gate decides when this request may go: at once, after a
            // block from an earlier 429 (this card's or any other's), or once
            // the learned per-minute window has room. A short wait is cheaper
            // to sit through here than to hand back; a long one is handed
            // back, typed and carrying the gate's own jittered wait, so
            // nothing holds a request (and, in the app, a generator
            // subprocess) open for a minute.
            const waitMs = await gate.acquire(model);
            if (waitMs > 0) {
                if (waitedMs + waitMs > maxRateLimitWaitMs) throw new GeminiRateLimitError(model, waitMs);
                await sleep(waitMs);
                waitedMs += waitMs;
                continue;
            }

            const response = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
                body,
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            const text = await response.text();

            if (response.status === 429) {
                const error = parseErrorBody(text).error ?? {};
                const details = error.details ?? [];
                const daily = dailyQuotaOf(details);
                if (daily) throw new GeminiDailyCapError(dailyQuotaMessage(model, daily));
                // A per-minute refusal is news for every request sharing
                // this key: the gate learns from it (block, doubling, a
                // lower cap) and the next acquire above says how long.
                const retryInfo = details.find((detail) => detail.retryDelay !== undefined);
                gate.record(model, 'rateLimited', parseRetryDelay(retryInfo?.retryDelay));
                continue;
            }

            if (!response.ok) {
                const message = (parseErrorBody(text).error?.message || text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
                const summary = `Gemini request to ${model} failed (HTTP ${response.status})${message ? `: ${message}` : ''}`;
                // A refused key, a bad request or an unknown model fails the
                // same way on every retry; a server error might not.
                if (response.status >= 400 && response.status < 500) throw new GeminiUnavailableError(summary);
                throw new Error(summary);
            }

            let data: GenerateContentResponse;
            try {
                data = JSON.parse(text) as GenerateContentResponse;
            } catch {
                throw new Error(`Gemini (${model}) returned a response that is not JSON`);
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

/** Base64 for an inlineData part. */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < view.length; i += chunkSize) {
        binary += String.fromCharCode(...view.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}
