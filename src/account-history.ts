import type {Express} from "express";
import type {SupabaseClient} from "@supabase/supabase-js";
import {isAdmin} from "./auth.js";

const LIMIT=50;
const LABELS:Record<string,string>={
  pending:"Waiting",running:"Processing raw video",quality_passed:"Quality checks passed",
  blocked:"Blocked",failed:"Failed",held:"Held for operator review",published:"Published (provider reported)",
  reserved:"Schedule slot reserved",upload_sending:"Upload started",upload_wait:"Upload processing",
  media_ready:"Media ready",submit_sending:"Schedule submission started",submit_wait:"Schedule processing",
  confirming:"Confirming with provider",scheduled:"Scheduled in Publer",assigned:"Account assigned",
  upload_intent:"Upload started",submit_intent:"Schedule submission started",claimed:"Worker claimed task",
  expired_write_held:"Uncertain submission held for review",
};
function label(v:string){return Object.hasOwn(LABELS,v)?LABELS[v]:"Status needs review";}
// Do not expose provider errors, signed URLs, captions, raw responses or lease tokens.
export function registerAccountHistory(app:Express,sbFn:()=>SupabaseClient){
  app.get("/api/v2/accounts/:accountId/history",async(req,res)=>{
    res.setHeader("Cache-Control","private, no-store");
    if(!req.auth)return res.status(401).json({error:"unauthorized"});
    const admin=isAdmin(req),uid="user_id" in req.auth?req.auth.user_id:null;
    if(!admin&&(!uid||!req.profile?.external_user_id))return res.status(403).json({error:"profile_required"});
    const key=String(req.params.accountId),match=key.match(/^(publer|publer-owned|managed|creatorvault):([A-Za-z0-9_-]{1,128})$/);
    if(!match)return res.status(404).json({error:"account_not_found"});
    try{
      const sb=sbFn(),kind=match[1],id=match[2];
      const one=async(q:any)=>{const r=await q.maybeSingle();if(r.error)throw r.error;return r.data;};
      const rows=async(q:any)=>{const r=await q.limit(LIMIT);if(r.error)throw r.error;return r.data??[];};
      const scoped=(table:string,cols:string,pk:string,owner:string,ownerValue:any)=>{
        let q=sb.from(table).select(cols).eq(pk,id);
        if(!admin)q=q.eq(owner,ownerValue);
        return q;
      };
      let a:any;
      if(kind==="publer")a=await one(scoped("publer_slot_config","phone_slot,owner_user_id,publer_account_id,paused","phone_slot","owner_user_id",uid));
      if(kind==="publer-owned")a=await one(scoped("publer_account_ownership","publer_account_id,owner_user_id,assigned_at","publer_account_id","owner_user_id",uid));
      if(kind==="managed")a=await one(scoped("managed_accounts","id,customer_user_id,publishing_enabled,state,created_at","id","customer_user_id",uid));
      if(kind==="creatorvault")a=await one(scoped("creatorvault_accounts","cv_account_id,external_user_id,connected_at,last_synced_at","cv_account_id","external_user_id",req.profile?.external_user_id));
      if(!a)return res.status(404).json({error:"account_not_found"});
      const events:any[]=[],current:any[]=[];
      let limited=false;
      const add=(id:string,at:any,stage:string,title:string,detail:string,attention=false)=>{
        if(typeof at==="string"&&Number.isFinite(Date.parse(at)))events.push({id,at,stage,title,detail,attention});
      };
      const track=(items:any[])=>{if(items.length===LIMIT)limited=true;return items;};
      if(kind==="publer"||kind==="publer-owned"){
        const own=kind==="publer-owned"?a:await one(sb.from("publer_account_ownership")
          .select("assigned_at").eq("publer_account_id",a.publer_account_id).eq("owner_user_id",a.owner_user_id));
        if(own)add("ownership",own.assigned_at,"connection","Ownership assigned","Assigned to this profile. This is not a live publishing-permission check.");
      }
      if(kind==="publer"){
        current.push({stage:"publishing",title:a.paused?"Schedule paused":"Schedule enabled",
          detail:"Configuration only; delivery must be checked against publishing records."});
        const logs=track(await rows(sb.from("publer_publish_log")
          .select("id,queue_id,status,attempted_at,updated_at,error").eq("phone_slot",a.phone_slot)
          .order("attempted_at",{ascending:false}).order("id",{ascending:false})));
        for(const l of logs){
          add(`attempt-${l.id}`,l.attempted_at,"publishing","Publishing attempt started","Recorded by the legacy publisher.");
          const held=l.status==="pending"&&(!!l.error||Date.parse(l.attempted_at)<Date.now()-20*60_000);
          add(`outcome-${l.id}`,l.updated_at??l.attempted_at,"publishing",
            held?"Pending submission needs review":label(l.status),
            held?"Current pending record, flagged for review at this check. Do not blindly resend.":
              l.status==="published"?"Provider-reported outcome; no independent permalink verification.":
              l.error?"An error was recorded. Private provider details are withheld.":"Latest saved outcome for this attempt.",
            held||!!l.error||l.status==="failed");
        }
        // Include old unresolved holds even if outside the recent 50 attempts.
        const holds=track(await rows(sb.from("publer_publish_log").select("id,status,attempted_at,updated_at,error")
          .eq("phone_slot",a.phone_slot).eq("status","pending").order("attempted_at",{ascending:true})));
        const heldCount=holds.filter(l=>l.error||Date.parse(l.attempted_at)<Date.now()-20*60_000).length;
        if(heldCount)current.push({stage:"publishing",title:"Unresolved submissions need review",
          detail:`${heldCount}${holds.length===LIMIT?"+":""} pending records need review. These may predate the recent activity window.`});
        for(const h of holds)if(!logs.some(l=>l.id===h.id)&&(h.error||Date.parse(h.attempted_at)<Date.now()-20*60_000))
          add(`hold-${h.id}`,h.updated_at??h.attempted_at,"publishing","Older pending submission needs review",
            "Timestamp is the last saved record update. The unresolved hold is flagged at this check; do not blindly resend.",true);
        const queueIds=[...new Set(logs.map(l=>l.queue_id).filter(Boolean))];
        if(queueIds.length)for(const s of track(await rows(sb.from("queue_suggestions").select("id,source,created_at")
          .in("queue_id",queueIds).order("created_at",{ascending:false}))))
          add(`suggestion-${s.id}`,s.created_at,"generation",
            s.source==="nightly_llm"?"AI caption suggestion prepared":"Caption suggestion prepared",
            "A saved suggestion exists for content in these publishing attempts. This event alone does not prove adoption or a learning update.");
        const latest=await one(sb.from("publer_analytics").select("captured_at").eq("phone_slot",a.phone_slot)
          .order("captured_at",{ascending:false}).limit(1));
        if(latest)add("analytics-latest",latest.captured_at,"analytics","Performance snapshot collected",
          "Analytics collection is recorded. It does not prove a learning update or an A/B-test winner.");
      }else if(kind==="publer-owned"){
        current.push({stage:"generation",title:"Awaiting content setup",
          detail:"Ownership only. No managed generation or publishing workflow is attached to this record."});
      }else if(kind==="creatorvault"){
        add("cv-connected",a.connected_at,"connection","Stored direct connection","Historical CreatorVault connection; publishing through this path is on hold.");
        add("cv-sync",a.last_synced_at,"analytics","Last stored data sync","Stored sync timestamp, not proof of current token eligibility.");
        current.push({stage:"publishing",title:"Direct publishing on hold",detail:"Publer is the active publishing path."});
      }else{
        current.push({stage:"publishing",title:a.publishing_enabled?"Scheduling permission enabled":"Scheduling permission disabled",
          detail:"Permission is not worker health or confirmation of a complete scheduled batch."});
        add("managed-created",a.created_at,"connection","Managed account created","Account-specific provisioning record created.");
        for(const e of track(await rows(sb.from("managed_audit").select("id,action,created_at")
          .eq("account_id",a.id).order("created_at",{ascending:false}))))
          add(`audit-${e.id}`,e.created_at,"connection",e.action==="assigned"?"Account assigned":"Setup event recorded",
            e.action?.startsWith("setup_blocked:")?"Setup was blocked; review the account setup status.":"Recorded by the managed setup service.",e.action?.startsWith("setup_blocked:"));
        const jobs=track(await rows(sb.from("managed_generation_jobs").select("id,ordinal,state,created_at")
          .eq("account_id",a.id).order("created_at",{ascending:false})));
        for(const j of jobs){
          add(`generation-${j.id}`,j.created_at,"generation",`Video ${j.ordinal} job created`,"Generation requested; creation alone does not mean rendering or quality checks completed.");
          current.push({stage:"generation",title:`Video ${j.ordinal}: ${label(j.state)}`,detail:"Current saved state. No completion timestamp is available in this record."});
        }
        if(jobs.length)for(const e of track(await rows(sb.from("managed_generation_attempts").select("job_id,claimed_at")
          .in("job_id",jobs.map(j=>j.id)).order("claimed_at",{ascending:false}))))
          add(`claim-${e.job_id}-${e.claimed_at}`,e.claimed_at,"generation","Video-processing attempt started","A generation worker claimed this job.");
        const handoffs=track(await rows(sb.from("managed_handoffs").select("id,state,updated_at,scheduled_at")
          .eq("account_id",a.id).order("updated_at",{ascending:false})));
        for(const h of handoffs)current.push({stage:"publishing",title:label(h.state),
          detail:`Current handoff state; scheduled time: ${h.scheduled_at}. A scheduled time is not proof of publication.`});
        if(handoffs.length)for(const e of track(await rows(sb.from("managed_handoff_events").select("id,event,created_at")
          .in("handoff_id",handoffs.map(h=>h.id)).order("created_at",{ascending:false}))))
          add(`handoff-${e.id}`,e.created_at,"publishing",label(e.event),"Recorded by the account-specific Publer handoff.",
            ["failed","held","blocked","expired_write_held"].includes(e.event));
      }
      events.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id));
      return res.json({account_id:key,checked_at:new Date().toISOString(),events,current,
        limited,window_note:"Recent activity: up to 50 records per source. Current states are not a complete transition audit. No missing history has been reconstructed.",
        learning_note:"No verified closed-loop learning or controlled A/B-test result is reported by this history."});
    }catch{return res.status(503).json({error:"account_history_unavailable"});}
  });
}
