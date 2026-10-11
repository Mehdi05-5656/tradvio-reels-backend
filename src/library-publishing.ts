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
