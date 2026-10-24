// Browser origins allowed to call the API with credentials.
// Defaults cover the production dashboard, Vercel previews of it, Clone8 domains and local dev.
// Extra origins come from CORS_ORIGINS (comma-separated, exact origins or *.domain wildcards).
const DEFAULT_ALLOWED = [
  "https://tradvio-reels.vercel.app",
  "*.vercel.app",        // preview deploys of the dashboard project
  "https://clone8.io",
  "*.clone8.io",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://127.0.0.1:5173",
];

export function allowedOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED, ...extra];
}

/** True when `origin` (scheme + host[:port]) matches an allowed entry. Wildcards match one or more subdomain labels over https only. */
export function isAllowedOrigin(origin: string | undefined, list = allowedOrigins()): boolean {
  if (!origin) return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.pathname !== "/" || url.search || url.hash) return false;
  const norm = `${url.protocol}//${url.host}`;
  for (const entry of list) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".vercel.app"
      if (url.protocol === "https:" && url.hostname.endsWith(suffix) && url.hostname.length > suffix.length) return true;
    } else if (entry === norm) return true;
  }
  return false;
}

/** Express middleware: echo only allowed origins; other callers get no CORS headers (non-browser clients are unaffected). */
export function corsMiddleware(list = allowedOrigins()) {
  return (req: any, res: any, next: (err?: any) => void) => {
    const origin = req.header("origin");
    if (origin && isAllowedOrigin(origin, list)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type,x-app-secret,authorization,x-creatorvault-signature");
    }
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  };
}
