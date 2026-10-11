import type { Express } from "express";
import { filterVisibleSlots } from "./auth.js";
import { loadSlots, ptNow, ptDateTimeToUtc } from "./publer-schedule.js";

export const MIN_REPORT_DATE="2026-09-05";
export const shiftDay=(day:string,n:number)=>new Date(Date.parse(day+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
export function resolveRange(query:any,now=new Date()){
  const today=ptNow(now).ymd;
  const from=String(query.from??shiftDay(today,-6)),to=String(query.to??today);
  for(const day of [from,to])if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new Error("invalid_date");
  if(from<MIN_REPORT_DATE||from>to||to>today||Date.parse(to)-Date.parse(from)>365*86400000)throw new Error("invalid_date_range");
  return {from,to,start:ptDateTimeToUtc(from,"00:00").toISOString(),end:ptDateTimeToUtc(shiftDay(to,1),"00:00").toISOString(),timezone:"America/Los_Angeles"};
}
export async function paged(fetchPage:(a:number,b:number)=>PromiseLike<any>,size=1000,maxPages=100){
  const rows:any[]=[];
  for(let i=0;i<maxPages;i++){
    const r=await fetchPage(i*size,(i+1)*size-1);
    if(r.error)throw r.error;
    rows.push(...(r.data??[]));
    if((r.data??[]).length<size)return rows;
  }
  throw new Error("report_too_large_choose_shorter_range");
}
const num=(v:any)=>v===null||v===undefined||v===""?null:Number.isFinite(Number(v))?Number(v):null;
const safeLink=(v:any)=>typeof v==="string"&&/^https:\/\/(www\.)?(instagram\.com|tiktok\.com)\//.test(v)?v:null;
const metrics=["video_views","reach","likes","comments","shares","saves"] as const;
const sumKnown=(rows:any[],key:string)=>{const values=rows.map(r=>num(r[key])).filter(v=>v!==null) as number[];return values.length?values.reduce((a,b)=>a+b,0):null;};
const identity=(r:any)=>`${r.phone_slot}|${r.publer_post_id}`;
export function buildReport(slots:any[],logs:any[],snapshots:any[],range:ReturnType<typeof resolveRange>){
  const allowed=new Set(slots.map(s=>s.phone_slot));
  logs=logs.filter(l=>allowed.has(l.phone_slot)&&l.slot_local_date>=range.from&&l.slot_local_date<=range.to);
  snapshots=snapshots.filter(s=>allowed.has(s.phone_slot)&&Date.parse(s.captured_at)<Date.parse(range.end))
    .map(s=>({...s,captured_at:new Date(s.captured_at).toISOString()}))
    .sort((a,b)=>Date.parse(a.captured_at)-Date.parse(b.captured_at)||Number(a.id)-Number(b.id));
  const series:any[]=[];
  for(let d=range.from;d<=range.to;d=shiftDay(d,1))series.push({date:d,observed_views:null,observations:0,accounts:{}});
  const dayMap=new Map(series.map(d=>[d.date,d]));
  const latest=new Map<string,any>(),alias=new Map<string,string>(),previous=new Map<string,any>();
  const gains=new Map<string,number[]>(),coverage={missing_baselines:0,corrections:0,snapshots:0,posts_with_metrics:0};
  const missing=new Set<string>();
  for(const s of snapshots){
    const key=identity(s),v=num(s.video_views),old=previous.get(key),day=ptNow(new Date(s.captured_at)).ymd;
    const raw=s.raw??{},published=raw.scheduled_at??raw.published_at;
    let delta:number|null=null;
    if(s.captured_at>=range.start){
      coverage.snapshots++;
      if(v!==null&&old&&num(old.video_views)!==null){
        delta=v-Number(old.video_views);
        if(delta<0){coverage.corrections++;delta=null;}
      } else if(v!==null&&published&&Date.parse(published)>=Date.parse(range.start)&&Date.parse(published)<=Date.parse(s.captured_at))delta=v;
      else if(v!==null)missing.add(key);
      if(delta!==null&&dayMap.has(day)){
        const bucket=dayMap.get(day)!;bucket.observed_views=(bucket.observed_views??0)+delta;bucket.observations++;
        bucket.accounts[s.phone_slot]=(bucket.accounts[s.phone_slot]??0)+delta;
        gains.set(s.phone_slot,[...(gains.get(s.phone_slot)??[]),delta]);
      }
    }
    previous.set(key,s);latest.set(key,s);
    // raw.old_id is the Publer post id our publisher recorded; TikTok posts often have no permalink in the log.
    for(const id of [s.publer_post_id,raw.id,raw.post_link,raw.old_id].filter(Boolean))alias.set(`${s.phone_slot}|${id}`,key);
  }
  coverage.missing_baselines=missing.size;
  const lookup=(l:any)=>latest.get(alias.get(`${l.phone_slot}|${l.publer_post_link}`)??alias.get(`${l.phone_slot}|${l.publer_post_id}`)??"");
  const posts:any[]=[],postKeys=new Set<string>(),matched=new Set<string>();
  for(const l of logs.filter(l=>l.status==="published")){
    const key=`${l.phone_slot}|${l.publer_post_id??l.publer_post_link??l.queue_id??`${l.slot_local_date}:${l.slot_index}`}`;
    if(postKeys.has(key))continue;postKeys.add(key);
    const s=lookup(l),raw=s?.raw??{};
    if(s)matched.add(identity(s));
    posts.push({id:key,phone_slot:l.phone_slot,post_link:safeLink(l.publer_post_link)??safeLink(raw.post_link),
      published_at:new Date(l.updated_at??l.attempted_at).toISOString(),caption:l.caption_used??raw.text??raw.caption??null,
      status:"published",recorded_by:"publisher",captured_at:s?.captured_at??null,
      ...Object.fromEntries(metrics.map(k=>[k,num(s?.[k])]))});
  }
  for(const [key,s] of latest){
    const raw=s.raw??{},at=raw.scheduled_at??raw.published_at;
    if(matched.has(key)||!at||Date.parse(at)<Date.parse(range.start)||Date.parse(at)>=Date.parse(range.end))continue;
    posts.push({id:key,phone_slot:s.phone_slot,post_link:safeLink(raw.post_link)??safeLink(s.publer_post_id),
      published_at:new Date(at).toISOString(),caption:raw.text??raw.caption??null,status:"provider_analytics",recorded_by:"analytics",
      captured_at:s.captured_at,...Object.fromEntries(metrics.map(k=>[k,num(s[k])]))});
  }
  posts.sort((a,b)=>b.published_at.localeCompare(a.published_at));
  coverage.posts_with_metrics=posts.filter(p=>p.captured_at).length;
  const accounts=slots.map(s=>{
    const attempts=logs.filter(l=>l.phone_slot===s.phone_slot).sort((a,b)=>Number(b.id)-Number(a.id));
    const windows=new Map<string,any[]>();
    for(const l of attempts){const k=`${l.slot_local_date}:${l.slot_index}`;windows.set(k,[...(windows.get(k)??[]),l]);}
    const unresolved=[...windows.values()].filter(ls=>!ls.some(l=>l.status==="published"));
    const own=posts.filter(p=>p.phone_slot===s.phone_slot),vs=gains.get(s.phone_slot);
    return {phone_slot:s.phone_slot,handle:s.handle,platform:s.provider,paused:s.paused,daily_target:s.daily_target,
      published:own.filter(p=>p.recorded_by==="publisher").length,posts:own.length,
      retry_windows:[...windows.values()].filter(ls=>ls.some(l=>l.status==="failed")&&ls.some(l=>l.status==="published")).length,
      attention:unresolved.length,observed_views:vs?.length?vs.reduce((a,b)=>a+b,0):null,
      known_post_views:sumKnown(own,"video_views"),metrics_available:own.filter(p=>p.captured_at).length,
      attempts:attempts.map(l=>({id:l.id,status:l.status,date:l.slot_local_date,slot_index:l.slot_index,
        planned_at:l.planned_at,at:l.attempted_at,error:l.error??null,post_link:safeLink(l.publer_post_link)}))};
  });
  return {range,checked_at:new Date().toISOString(),accounts,posts,series,coverage,
    totals:{accounts:accounts.length,published:accounts.reduce((n,a)=>n+a.published,0),
      attention:accounts.reduce((n,a)=>n+a.attention,0),attempts:logs.length,
      observed_views:sumKnown(accounts,"observed_views"),known_post_views:sumKnown(posts,"video_views")},
    notes:["View gains are changes observed between saved snapshots, attributed to the later capture day; not exact time-of-view events.",
      "Missing baselines and downward metric corrections are excluded. Unknown metrics are not zero.",
      "Video totals use the latest available snapshot before the selected range ends. Daily history is an as-of view, not today's lifetime total."]};
}
export function registerReportingRoutes(app:Express,sbFn:()=>any){
  app.get("/api/v2/report",async(req,res)=>{
    try{
      const range=resolveRange(req.query),sb=sbFn();
      const visible=filterVisibleSlots(req,await loadSlots(sb));
      const requested=String(req.query.accounts??"").split(",").filter(Boolean);
      if(requested.some(id=>!visible.some(s=>s.phone_slot===id)))return res.status(403).json({error:"account_not_accessible"});
      const slots=requested.length?visible.filter(s=>requested.includes(s.phone_slot)):visible;
      if(!slots.length)return res.json(buildReport([],[],[],range));
      const ids=slots.map(s=>s.phone_slot);
      const logs=await paged((a,b)=>sb.from("publer_publish_log")
        .select("id,phone_slot,queue_id,slot_local_date,slot_index,status,planned_at,attempted_at,updated_at,publer_post_id,publer_post_link,caption_used,error")
        .in("phone_slot",ids).gte("slot_local_date",range.from).lte("slot_local_date",range.to).order("id").range(a,b));
      const r=await sb.rpc("dashboard_report_snapshots",{p_slots:ids,p_start:range.start,p_end:range.end});
      if(r.error)throw r.error;
      const result=buildReport(slots,logs,r.data??[],range);
      res.set("Cache-Control","private, no-store").json(result);
    }catch(e:any){res.status(/^invalid_date/.test(e.message)?400:503).json({error:/report_too_large/.test(e.message)?"report_too_large_choose_shorter_range":/^invalid_date/.test(e.message)?e.message:"report_unavailable"});}
  });
}
