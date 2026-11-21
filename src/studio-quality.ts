// Clip quality (owner, Nov 21 2026): every plan cuts clips at 720p by default; 1080p HD is a choice for Creator and up
// (Studio, the owner pass and the owner's own account too). It applies to clips cut from a link (YouTube, Twitch,
// Kick); an uploaded video is cut from the file as it is. The finished clip is 1080x1920 either way: the choice is how
// many lines of the source it is cut from (a vertical slice of a 16:9 source is 405 pixels wide from 720 lines, 607
// from 1080). STUDIO_CLIPS_HD=off holds every run at 720 without a deploy.
export type ClipQuality = "720" | "1080";
export const qualityOf = (v: unknown): ClipQuality => (String(v ?? "") === "1080" ? "1080" : "720");
export const HD_PLANS: readonly string[] = ["creator", "studio"];
/** Whether this customer may pick 1080p: Creator and up, the owner pass, or the owner's account. */
export function hdAllowed(c: { plan_id?: string | null; owner_pass?: boolean | null } | null | undefined, owner = false): boolean {
  return owner || !!c?.owner_pass || HD_PLANS.includes(String(c?.plan_id ?? ""));
}
/** The source lines a run is cut from. */
export function cutLines(q: ClipQuality, env: Record<string, string | undefined>): 720 | 1080 {
  return env.STUDIO_CLIPS_HD === "off" ? 720 : q === "1080" ? 1080 : 720;
}
