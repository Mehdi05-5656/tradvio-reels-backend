// Makes src/studio-splitscreen-catalog.ts from the category library on this Mac:
//   splitscreen-library/sources-v2.tsv   one line per loop: id, source video, stretch, category, category label
//   splitscreen-library/v2/safe.tsv      one line per source video: id, x, y, w, h, cy (the safe area and where the
//                                        action sits, set from its contact sheets; a missing line = the whole picture)
//   splitscreen-library/v2/drop.txt      loop ids left out (a watermark in the middle, an intro, a black stretch)
//   splitscreen-library/v2/clean/*.mp4   the cleaned loops (size and length are read from the files)
// Usage: node scripts/splitscreen-catalog.mjs [library dir]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = process.argv[2] ?? path.resolve(HERE, "../../splitscreen-library");
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : []);
const sources = read(path.join(LIB, "sources-v2.tsv")).map((l) => { const [id, src, , kind, label] = l.split("\t"); return { id, src, kind, label }; });
const safe = new Map(read(path.join(LIB, "v2", "safe.tsv")).map((l) => { const [src, x, y, w, h, cy] = l.split(/\s+/); return [src, { x: +x, y: +y, w: +w, h: +h, cy: cy ? +cy : 0.5 }]; }));
const drop = new Set(read(path.join(LIB, "v2", "drop.txt")).map((l) => l.split(/\s+/)[0]));
const probe = (f) => { const [w, h] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", f]).toString().trim().split(",").map(Number); const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString()); return { w, h, d }; };

const out = [], missing = [], counts = {};
for (const s of sources) {
  if (drop.has(s.id)) continue;
  const f = path.join(LIB, "v2", "clean", `${s.id}.mp4`);
  if (!fs.existsSync(f) || !fs.existsSync(path.join(LIB, "v2", "posters", `${s.id}.jpg`))) { missing.push(s.id); continue; }
  const p = probe(f), a = safe.get(s.src);
  counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  const full = !a || (a.x === 0 && a.y === 0 && a.w === 1 && a.h === 1);
  out.push({ id: s.id, kind: s.kind, name: `${s.label} ${counts[s.kind]}`, w: p.w, h: p.h, seconds: Math.floor(p.d), ...(full ? {} : { safe: { x: a.x, y: a.y, w: a.w, h: a.h } }), ...(a && a.cy !== 0.5 ? { cy: a.cy } : {}) });
}
const body = out.map((c) => `  ${JSON.stringify(c).replace(/"(\w+)":/g, "$1: ")},`).join("\n");
fs.writeFileSync(path.resolve(HERE, "../src/studio-splitscreen-catalog.ts"), `// Made by scripts/splitscreen-catalog.mjs from splitscreen-library/v2 (the cleaned loops) and each source's safe area.
// Do not edit by hand: change the sources file, the safe areas or the drop list and run the script again.
export type CatalogLoop = { id: string; kind: string; name: string; w: number; h: number; seconds: number; safe?: { x: number; y: number; w: number; h: number }; cy?: number };
export const CATALOG: CatalogLoop[] = [
${body}
];
`);
console.log(`${out.length} loops written; per category: ${JSON.stringify(counts)}${missing.length ? `; not ready: ${missing.length}` : ""}${drop.size ? `; left out: ${drop.size}` : ""}`);
