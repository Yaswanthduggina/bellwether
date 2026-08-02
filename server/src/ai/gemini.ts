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

import dotenv from "dotenv";
dotenv.config({ override: true });
import { GoogleGenAI, ThinkingLevel, type Schema } from "@google/genai";

/**
 * A CHAIN of models, primary first, not a single name — because of how the free
 * tier is actually metered.
 *
 * The quota that bites is `GenerateRequestsPerDayPerProjectPerModel-FreeTier`:
 * twenty requests per DAY, counted per PROJECT and per MODEL. Two consequences,
 * both of which cost real time to learn:
 *
 *   - Minting a new API key inside the SAME Google project changes nothing. The
 *     bucket belongs to the project, not to the key. Only a key from a new
 *     project — or a different Google account — is a fresh allowance. Anyone
 *     who pastes a new key, sees the identical 429, and concludes the key was
 *     not picked up has been misled by the error, not by the code.
 *   - A different MODEL is a separate bucket. When gemini-3.6-flash is spent,
 *     the same key still has its full allowance on gemini-3.5-flash.
 *
 * So the useful response to one exhausted model is to move down the chain, not
 * to stop. Only when every entry is spent is the day genuinely over, and that is
 * the only case that now surfaces as QuotaExhaustedError.
 *
 * Overridable per environment so a demo can be pinned to a model known to have
 * headroom without a code change: comma-separated, primary first.
 */
function modelChain(variable: string, fallback: readonly string[]): readonly string[] {
    const configured = (process.env[variable] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");

    return configured.length > 0 ? configured : fallback;
}

/**
 * Classification: high volume, shallow judgement, tightly constrained by the
 * schema. Thinking is set to MINIMAL — measured at 0 thought tokens against
 * ~500 at the default, with identical labels on the probe set. Paying for
 * reasoning that does not change the answer is just paying.
 *
 * The fallbacks are ordered by capability, so a chain that has fallen through is
 * degrading gently rather than jumping to whatever is cheapest.
 */
export const CLASSIFY_MODELS = modelChain("GEMINI_CLASSIFY_MODEL", [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
]);

/**
 * Recommendations: low volume, and the one place output quality is the product.
 * Same primary model, thinking turned up — the hard part is reasoning about
 * which of several verified findings actually matters to a communications team,
 * and that is worth the tokens on a handful of calls.
 *
 * Falling back matters less here than it looks like it should: every number a
 * recommendation contains is checked against the report by `validate.ts`
 * afterwards, so a weaker model produces blander advice, not wronger advice.
 */
export const RECOMMEND_MODELS = modelChain("GEMINI_RECOMMEND_MODEL", [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
]);

/** The primary of each chain, for anything that needs to name one model. */
export const CLASSIFY_MODEL: string = CLASSIFY_MODELS[0] ?? "gemini-3.6-flash";
export const RECOMMEND_MODEL: string = RECOMMEND_MODELS[0] ?? "gemini-3.6-flash";

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
function readKey(): string | undefined {
    // Re-read .env on every lookup rather than trusting the copy loaded at
    // import. The file is a few hundred bytes and the network call it precedes
    // takes seconds, so the cost is nil — and it buys the thing that matters
    // when a key has to be swapped mid-demo: the new key takes effect on the
    // next request instead of requiring a server restart nobody remembers is
    // needed. `tsx watch` does not help here; it watches imported TypeScript,
    // not .env.
    dotenv.config({ override: true, quiet: true });
    return process.env["GEMINI_API_KEY"] ?? process.env["gemini_api_key"];
}

function apiKey(): string {
    const key = readKey();
    if (!key || key.trim() === "") throw new MissingApiKeyError();
    return key.trim();
}

export function hasApiKey(): boolean {
    const key = readKey();
    return Boolean(key && key.trim() !== "");
}

/**
 * Memoised on the KEY, not unconditionally.
 *
 * The SDK client captures its key at construction, so a plain `client ??= ...`
 * would keep serving the key the process started with — and re-reading .env
 * above would achieve exactly nothing. Keying the cache on the value is what
 * makes a mid-run key swap real rather than apparent.
 */
let cached: { key: string; client: GoogleGenAI } | undefined;

function genai(): GoogleGenAI {
    const key = apiKey();
    if (cached?.key !== key) cached = { key, client: new GoogleGenAI({ apiKey: key }) };
    return cached.client;
}

export interface StructuredCallOptions {
    /**
     * One model, or a chain tried in order. A later entry is reached only when
     * an earlier one's daily quota is spent — never on a bad request, and never
     * on a malformed response, both of which would fail the same way twice.
     */
    model: string | readonly string[];
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
    /**
     * Which model actually answered — not necessarily the one asked first. A
     * run that fell through to a fallback should say so rather than report the
     * primary and be quietly wrong about its own provenance.
     */
    model: string;
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
    constructor(
        readonly detail: string,
        readonly modelsTried: readonly string[] = [],
    ) {
        super(
            `Gemini quota exhausted${modelsTried.length > 1 ? ` on every model tried (${modelsTried.join(", ")})` : ""}. ` +
                `The free tier meters requests per DAY, per PROJECT, per MODEL — so a new API key issued from ` +
                `the same Google project draws on the same spent allowance and will fail identically. What ` +
                `resets it: a key from a NEW project (or a different Google account), or a model with its own ` +
                `untouched bucket via GEMINI_CLASSIFY_MODEL / GEMINI_RECOMMEND_MODEL in server/.env. ` +
                `Work already completed is saved and the run is incremental, so re-running continues where it ` +
                `stopped. Detail: ${detail}`,
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
 * One schema-constrained call to ONE model, with retry on transient failures.
 *
 * Returns the parsed object. It does NOT validate the object's CONTENT — that
 * is `validate.ts`, deliberately separate and deliberately not an LLM. This
 * function guarantees shape; nothing here guarantees truth.
 */
async function callModel<T>(
    model: string,
    options: StructuredCallOptions,
    attempts: number,
): Promise<StructuredResult<T>> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const response = await genai().models.generateContent({
                model,
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
                    `${model} returned no text (finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"}).`,
                    text,
                );
            }

            let value: T;
            try {
                value = JSON.parse(text) as T;
            } catch {
                throw new MalformedResponseError(`${model} returned text that is not JSON.`, text);
            }

            const usage = response.usageMetadata;
            return {
                value,
                model,
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

            // Spent quota, not throttling. Retrying THIS model is guaranteed to
            // fail; the caller decides whether another model is worth trying.
            if (isQuotaExhausted(error)) {
                throw new QuotaExhaustedError(
                    error instanceof Error ? error.message.slice(0, 200) : String(error),
                    [model],
                );
            }

            if (!isTransient(error) || attempt === attempts) throw error;

            await sleep(500 * 2 ** (attempt - 1));
        }
    }

    throw lastError;
}

/**
 * One schema-constrained call, falling through the model chain on exhaustion.
 *
 * The fall-through is narrow on purpose. A spent daily quota is the ONE failure
 * where a different model is a real answer: the request was fine, the key was
 * fine, and the next model has its own allowance. Everything else — a malformed
 * response, a bad schema, a 400 — would fail identically on model two, so it
 * propagates immediately rather than burning the fallbacks proving it.
 */
export async function structured<T>(options: StructuredCallOptions, attempts = 3): Promise<StructuredResult<T>> {
    const chain = typeof options.model === "string" ? [options.model] : [...options.model];
    if (chain.length === 0) throw new Error("structured() was given an empty model chain.");

    let lastDetail = "";

    for (const [position, model] of chain.entries()) {
        try {
            return await callModel<T>(model, options, attempts);
        } catch (error) {
            if (!(error instanceof QuotaExhaustedError)) throw error;

            lastDetail = error.detail;

            // Named in the log because a silent downgrade is the kind of thing
            // that gets discovered later, from output that reads slightly worse
            // than it should for reasons nobody can reconstruct.
            const next = chain[position + 1];
            if (next !== undefined) {
                console.warn(`[gemini] ${model} is out of daily quota — falling back to ${next}.`);
            }
        }
    }

    throw new QuotaExhaustedError(lastDetail, chain);
}

export { ThinkingLevel };
