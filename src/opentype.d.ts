// opentype.js ships no types; Captions only reads advance widths from it (studio-caption-video.ts).
declare module "opentype.js" {
  export type Font = { unitsPerEm: number; getAdvanceWidth(text: string, fontSize: number, options?: Record<string, unknown>): number };
  export function loadSync(path: string): Font;
  export function parse(buffer: ArrayBuffer): Font;
  const opentype: { loadSync: typeof loadSync; parse: typeof parse };
  export default opentype;
}
