// JSON that keeps 64-bit integers, without the json-bigint dependency Appwrite's
// SDKs use.

const MIN_INT64 = BigInt('-9223372036854775808');
const MAX_INT64 = BigInt('9223372036854775807');

/**
 * Integers beyond Number.MAX_SAFE_INTEGER come back as BigInt where the
 * runtime lets a reviver see the source text; elsewhere they are numbers, as
 * with plain JSON.parse.
 */
function reviver(_key: string, value: unknown, context?: { source?: string }): unknown {
    if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        !Number.isSafeInteger(value) &&
        context?.source &&
        /^-?\d+$/.test(context.source)
    ) {
        const big = BigInt(context.source);
        if (big >= MIN_INT64 && big <= MAX_INT64) return big;
    }
    return value;
}

const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown }).rawJSON;

export const JSONbig = {
    parse: (text: string): any => JSON.parse(text, reviver as any),
    stringify: (value: unknown): string =>
        JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? (rawJSON ? rawJSON(v.toString()) : Number(v)) : v)),
};
