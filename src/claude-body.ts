// A Claude request body that is always valid JSON (Nov 26 2026): text cut by .slice() can end in half of an emoji (a
// lone UTF-16 surrogate). JSON.stringify writes it as a lone "\ud83d", which Claude's parser refuses ("The request body
// is not valid JSON: unexpected end of hex escape"). A Live Clips run on a stream titled with 💰 lost every moment check
// this way: the title is cut at 80 characters, inside an emoji. Every string is made well-formed before it is sent; a
// broken half becomes U+FFFD, the rest is untouched.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const wellFormed = (s: string): string => s.replace(LONE, "�");
export const claudeBody = (body: unknown): string => JSON.stringify(body, (_k, v) => (typeof v === "string" ? wellFormed(v) : v));
