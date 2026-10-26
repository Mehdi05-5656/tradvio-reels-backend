export function libraryPublishingEnabled(){
  return process.env.LIBRARY_PUBLISHING_ENABLED==="1"&&process.env.PUBLER_WORKSPACE_COORDINATION_ENABLED==="1";
}
export function queueMediaBucket(row:any):"reels"|"managed-variants"{
  const bucket=row.storage_bucket??"reels";
  if(bucket==="reels"&&!row.library_variant_id&&!String(row.phone_slot??"").startsWith("library_"))return "reels";
  const account=String(row.phone_slot??"").match(/^library_([a-f0-9]{24})$/)?.[1];
  const uuid="[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  if(bucket!=="managed-variants"||!account||!new RegExp(`^${uuid}$`).test(row.library_variant_id??"")
    ||!new RegExp(`^library/${uuid}/${account}/${row.library_variant_id}/${uuid}[.]mp4$`).test(row.storage_path??""))
    throw new Error("invalid_library_media");
  return "managed-variants";
}
export function libraryWindowAllowed(notBefore:any,planned:string,now=Date.now()){
  const start=Date.parse(notBefore),slot=Date.parse(planned);
  return Number.isFinite(start)&&Number.isFinite(slot)&&now>=start&&slot>=start&&slot<=now&&now-slot<=45*60000;
}
export async function libraryReceipt(sb:any,row:any,account:string){
  const r=await sb.rpc("library_publication_receipt",{p_queue:row.id,p_account:account});
  if(r.error||!r.data||r.data.storage_bucket!==queueMediaBucket(row)||r.data.storage_path!==row.storage_path
    ||r.data.variant_id!==row.library_variant_id||typeof r.data.caption!=="string"
    ||r.data.caption.length<20||r.data.caption.length>800||!r.data.settings)
    throw new Error("library_publication_not_authorized");
  return r.data;
}

/** Hashtags for a library post: the suggestion the console accepted (or the nightly one) for this queue row when the
 *  client has one, otherwise the client's own learning.hashtags. Never another client's and never a constant. */
export function pickLibraryHashtags(learning: any, suggestion: { user_action?: string; suggested_hashtags?: string[] | null; final_hashtags?: string[] | null } | null | undefined): { hashtags: string[]; source: "accepted_suggestion" | "nightly_suggestion" | "client_hashtags" | "none" } {
  const clean = (list: any): string[] => (Array.isArray(list) ? list : []).map((t: any) => String(t ?? "").trim().replace(/^#/, "")).filter((t: string, i: number, a: string[]) => t && a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i).slice(0, 30);
  if (suggestion && suggestion.user_action === "accepted") { const t = clean(suggestion.final_hashtags?.length ? suggestion.final_hashtags : suggestion.suggested_hashtags); if (t.length) return { hashtags: t, source: "accepted_suggestion" }; }
  if (suggestion && suggestion.user_action === "pending") { const t = clean(suggestion.suggested_hashtags); if (t.length) return { hashtags: t, source: "nightly_suggestion" }; }
  const own = clean(learning?.hashtags);
  return own.length ? { hashtags: own, source: "client_hashtags" } : { hashtags: [], source: "none" };
}
export async function libraryHashtags(sb: any, slot: string, queueId: string): Promise<{ hashtags: string[]; source: string }> {
  const [sug, org] = await Promise.all([
    sb.from("queue_suggestions").select("user_action, suggested_hashtags, final_hashtags").eq("queue_id", queueId).in("user_action", ["accepted", "pending"]).order("user_action", { ascending: true }).limit(1).maybeSingle(),
    sb.rpc("client_learning_for_slot", { p_slot: slot }),
  ]);
  if (org.error) throw org.error;
  return pickLibraryHashtags(org.data?.learning, sug.error ? null : sug.data);
}
