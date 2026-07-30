// The LLM client. One file, so the model choice and the failure handling have
// exactly one home.
//
// WHERE THE LLM IS AND IS NOT USED
//
// It does two jobs in this product and no others: CLASSIFYING content into
// themes (a judgement task that rules do badly) and WRITING recommendations
// from verified numbers (a language task). All arithmetic, all aggregation, all
// sample-size gating and all validation are deterministic, tested code. That
// boundary is the architecture, not a detail — see README.
//
// STRUCTURED OUTPUT IS THE GROUNDING MECHANISM, NOT A CONVENIENCE.
// Every call here is schema-constrained and nothing is parsed out of free text.
// A model that cannot emit a field cannot smuggle an unverifiable claim into
// one, and a validator that never has to regex prose cannot be defeated by
// prose. `responseSchema` is doing structural work.

import "dotenv/config";
import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";

/**
 * Classification: high volume, shallow judgement, tightly constrained by the
 * schema. Thinking is set to MINIMAL — measured at 0 thought tokens against
 * ~500 at the default, with identical labels on the probe set. Paying for
 * reasoning that does not change the answer is just paying.
 */
export const CLASSIFY_MODEL = "gemini-3.6-flash";

/**
 * Recommendations: low volume, and the one place output quality is the product.
 * Same model, thinking turned up — the hard part is reasoning about which of
 * several verified findings actually matters to a communications team, and that
 * is worth the tokens on a handful of calls.
 */
export const RECOMMEND_MODEL = "gemini-3.6-flash";

/** Raised when no key is configured. Caught at the route so the UI can say what to do. */
export class MissingApiKeyError extends Error {
    constructor() {
        super(
            "No Gemini API key configured. Set GEMINI_API_KEY in server/.env — " +
                "the analytics layer works fully without it, but classification and recommendations do not.",
        );
        this.name = "MissingApiKeyError";
    }
}

/** Raised when the model returned something the schema should have prevented. */
export class MalformedResponseError extends Error {
    constructor(
        message: string,
        readonly raw: string | undefined,
    ) {
        super(message);
        this.name = "MalformedResponseError";
    }
}

/**
 * Both spellings are accepted deliberately.
 *
 * GEMINI_API_KEY is the documented name and what `.env.example` says. The
 * lowercase form is read too because Windows treats environment variables
 * case-insensitively while Node's `process.env` does not always normalise them
 * — so a `.env` that works on one machine silently yields "no key configured"
 * on another, which is a confusing hour for anyone cloning this repo.
 */
function apiKey(): string {
    const key = process.env["GEMINI_API_KEY"] ?? process.env["gemini_api_key"];
    if (!key || key.trim() === "") throw new MissingApiKeyError();
    return key.trim();
}

export function hasApiKey(): boolean {
    const key = process.env["GEMINI_API_KEY"] ?? process.env["gemini_api_key"];
    return Boolean(key && key.trim() !== "");
}

let client: GoogleGenAI | undefined;

function genai(): GoogleGenAI {
    return (client ??= new GoogleGenAI({ apiKey: apiKey() }));
}

export interface StructuredCallOptions {
    model: string;
    /** The instruction block. Kept out of `contents` so it is cached and reused. */
    system: string;
    contents: string;
    schema: Schema;
    thinking?: ThinkingLevel;
    /**
     * 0 by default. These are analytical calls, not creative ones — the same
     * corpus should classify the same way twice, and a reviewer re-running the
     * demo should see what the screenshots show.
     */
    temperature?: number;
}

export interface StructuredResult<T> {
    value: T;
    usage: { promptTokens: number; outputTokens: number; thoughtTokens: number };
}

/**
 * Raised when the account's quota is spent, as opposed to momentarily throttled.
 *
 * The distinction is not pedantic and it cost a real run to learn. Both arrive
 * as HTTP 429, and treating them the same means a per-DAY quota exhaustion gets
 * the per-minute treatment: three retries with backoff, per batch, for every
 * remaining batch. The first full classification pass ground through 20 batches
 * × 3 attempts after the quota was already gone, and every one was guaranteed
 * to fail before it was sent.
 *
 * A throttle is weather and you wait it out. An exhausted quota is a wall, and
 * the only useful response is to stop and say so.
 */
export class QuotaExhaustedError extends Error {
    constructor(readonly detail: string) {
        super(
            `Gemini quota exhausted. Work already completed is saved and the run is incremental, ` +
                `so re-running after the quota resets continues where it stopped. Detail: ${detail}`,
        );
        this.name = "QuotaExhaustedError";
    }
}

/**
 * Tell an exhausted quota from a momentary throttle.
 *
 * Gemini phrases the terminal case as "exceeded your current quota ... check
 * your plan and billing details". A throttle carries a retryDelay and no
 * billing language. Matched conservatively: a misread throttle costs one
 * aborted run the user can simply repeat, while a misread exhaustion costs
 * minutes of guaranteed-failing requests.
 */
function isQuotaExhausted(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("exceeded your current quota") ||
        message.includes("billing details") ||
        message.includes("QUOTA_EXCEEDED")
    );
}

/** Transient conditions worth retrying. A 400 is a bug in our request, not weather. */
function isTransient(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("429") ||
        message.includes("500") ||
        message.includes("503") ||
        message.includes("UNAVAILABLE") ||
        message.includes("RESOURCE_EXHAUSTED") ||
        message.includes("ECONNRESET") ||
        message.includes("fetch failed")
    );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One schema-constrained call, with retry on transient failures only.
 *
 * Returns the parsed object. It does NOT validate the object's CONTENT — that
 * is `validate.ts`, deliberately separate and deliberately not an LLM. This
 * function guarantees shape; nothing here guarantees truth.
 */
export async function structured<T>(options: StructuredCallOptions, attempts = 3): Promise<StructuredResult<T>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await genai().models.generateContent({
                model: options.model,
                contents: options.contents,
                config: {
                    systemInstruction: options.system,
                    responseMimeType: "application/json",
                    responseSchema: options.schema,
                    temperature: options.temperature ?? 0,
                    ...(options.thinking ? { thinkingConfig: { thinkingLevel: options.thinking } } : {}),
                },
            });

            const text = response.text;
            if (text === undefined || text.trim() === "") {
                // Usually a safety block or a truncated candidate. Worth naming,
                // because it looks identical to a network failure from outside.
                throw new MalformedResponseError(
                    `${options.model} returned no text (finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"}).`,
                    text,
                );
            }

            let value: T;
            try {
                value = JSON.parse(text) as T;
            } catch {
                throw new MalformedResponseError(`${options.model} returned text that is not JSON.`, text);
            }

            const usage = response.usageMetadata;
            return {
                value,
                usage: {
                    promptTokens: usage?.promptTokenCount ?? 0,
                    outputTokens: usage?.candidatesTokenCount ?? 0,
                    thoughtTokens: usage?.thoughtsTokenCount ?? 0,
                },
            };
        } catch (error) {
            lastError = error;

            // A malformed response is not weather either — retrying an identical
            // request at temperature 0 will produce an identical failure.
            if (error instanceof MissingApiKeyError || error instanceof MalformedResponseError) throw error;

            // Spent quota, not throttling. Retrying is guaranteed to fail and
            // the caller needs to hear "stop", not "still trying".
            if (isQuotaExhausted(error)) {
                throw new QuotaExhaustedError(error instanceof Error ? error.message.slice(0, 200) : String(error));
            }

            if (!isTransient(error) || attempt === attempts) throw error;

            await sleep(500 * 2 ** (attempt - 1));
        }
    }

    throw lastError;
}

export { ThinkingLevel };
