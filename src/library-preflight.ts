// Explicit one-off private media handoff. Never imports or calls publishNow.
import {createClient} from "@supabase/supabase-js";
import {coordinatedUpload} from "./workspace-upload.js";
import {queueMediaBucket} from "./library-publishing.js";
import {loadConfig} from "./publer-schedule.js";

async function main(){
  const account=process.env.LIBRARY_PREFLIGHT_ACCOUNT;
  if(process.env.LIBRARY_PRIVATE_PREFLIGHT!=="1"||!account||!/^[a-f0-9]{24}$/.test(account))
    throw new Error("private_preflight_not_enabled");
  const sb=createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {auth:{persistSession:false,autoRefreshToken:false}});
  const cfg=await loadConfig(sb);
  const {data:policy,error:pe}=await sb.from("library_publishing_policy").select("*").eq("account_id",account).single();
  const {data:own,error:oe}=await sb.from("publer_account_ownership").select("*").eq("publer_account_id",account).single();
  if(pe||oe||!policy?.enabled||policy.owner_user_id!==own?.owner_user_id||own?.workspace_id!==cfg.workspaceId)
    throw new Error("private_preflight_scope_mismatch");
  const {data:rows,error}=await sb.from("reels_manual_queue").select("*").eq("phone_slot","library_"+account)
    .eq("status","pending").not("library_variant_id","is",null).order("created_at").limit(1);
  if(error||rows?.length!==1)throw new Error("private_preflight_queue_missing");
  const row=rows[0];
  const {data:variant,error:ve}=await sb.from("library_variants").select("*").eq("id",row.library_variant_id).single();
  if(ve||variant?.account_id!==account||variant.owner_user_id!==own.owner_user_id||variant.workspace_id!==cfg.workspaceId||
    variant.state!=="rendered_private"||variant.result?.full_decode_passed!==true||
    variant.result.object_key!==row.storage_path||variant.result.sha256!==row.content_video_hash)
    throw new Error("private_preflight_variant_mismatch");
  const bucket=queueMediaBucket(row);
  const {data:signed,error:se}=await sb.storage.from(bucket).createSignedUrl(row.storage_path,3600);
  if(se||!signed?.signedUrl)throw new Error("private_preflight_sign_failed");
  const payload=await coordinatedUpload(sb,cfg.workspaceId,signed.signedUrl,row.filename);
  const media=Array.isArray(payload)?payload:Array.isArray(payload?.media)?payload.media:
    payload?.media?[payload.media]:payload?.id?[payload]:[];
  if(media.length!==1||!media[0].id||media[0].error)throw new Error("private_preflight_media_unconfirmed");
  console.log(JSON.stringify({status:"private_upload_confirmed",account_id:account,
    queue_id:row.id,variant_id:row.library_variant_id,media_id:String(media[0].id),publishing_called:false}));
}
main().catch(()=>{console.error("private_preflight_failed; reconcile exact workspace upload job before retry");process.exit(1)});
