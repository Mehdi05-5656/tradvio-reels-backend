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
// Publer stores a poster frame per post; only the small variant is publicly readable.
export function publerThumbnail(raw:any):string|null{
  const media=raw?.media?.[0];if(!media)return null;
  const idx=Number.isInteger(media.default_thumbnail)?media.default_thumbnail:0;
  const url=media.thumbnails?.[idx]?.small??media.thumbnails?.[0]?.small;
  return typeof url==="string"&&/^https:\/\/cdn\.publer\.com\//.test(url)?url:null;
}
const metrics=["video_views","reach","likes","comments","shares","saves"] as const;
const sumKnown=(rows:any[],key:string)=>{const values=rows.map(r=>num(r[key])).filter(v=>v!==null) as number[];return values.length?values.reduce((a,b)=>a+b,0):null;};
const identity=(r:any)=>`${r.phone_slot}|${r.publer_post_id}`;
// Platform identity shared by Publer and live sources: Instagram shortcode or TikTok video id.
export function platformKey(link:any):string|null{
  if(typeof link!=="string")return null;
  let m=link.match(/instagram\.com\/(?:[^/?#]+\/)?(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);if(m)return `ig:${m[1]}`;
  m=link.match(/tiktok\.com\/@[^/?#]+\/video\/(\d+)/);if(m)return `tt:${m[1]}`;
  return null;
}
// Live numbers win while they are no more than 6 hours older than Publer's latest capture.
export const LIVE_PREFERENCE_MS=6*3600_000;
export function buildReport(slots:any[],logs:any[],snapshots:any[],range:ReturnType<typeof resolveRange>,live:any[]=[],liveAccounts:any[]=[]){
  const allowed=new Set(slots.map(s=>s.phone_slot));
  logs=logs.filter(l=>allowed.has(l.phone_slot)&&l.slot_local_date>=range.from&&l.slot_local_date<=range.to);
  const prep=(rows:any[],source:string)=>rows.filter(s=>allowed.has(s.phone_slot)&&Date.parse(s.captured_at)<Date.parse(range.end))
    .map(s=>({...s,source,captured_at:new Date(s.captured_at).toISOString()}))
    .sort((a,b)=>Date.parse(a.captured_at)-Date.parse(b.captured_at)||Number(a.id)-Number(b.id));
  snapshots=prep(snapshots,"publer");live=prep(live,"live");
  const alias=new Map<string,string>();
  const keyOf=(s:any)=>{
    if(s.source==="live")return `${s.phone_slot}|${s.provider==="instagram"?"ig":"tt"}:${s.platform_post_id}`;
    const pk=platformKey(s.raw?.post_link)??platformKey(s.publer_post_id);
    return pk?`${s.phone_slot}|${pk}`:identity(s);
  };
  for(const s of snapshots){const k=keyOf(s),raw=s.raw??{};
    // raw.old_id is the Publer post id our publisher recorded; TikTok posts often have no permalink in the log.
    for(const id of [s.publer_post_id,raw.id,raw.post_link,raw.old_id,platformKey(raw.post_link),platformKey(s.publer_post_id)].filter(Boolean))alias.set(`${s.phone_slot}|${id}`,k);}
  for(const s of live){const k=keyOf(s);
    for(const id of [s.publer_post_id,s.post_link,platformKey(s.post_link)].filter(Boolean))alias.set(`${s.phone_slot}|${id}`,k);}
  // One timeline per post and per source. Publer and the public profile count views differently
  // (for TikTok, Publer's "views" are reach), so a change is only ever measured between two
  // readings from the same source. When both sources observe a post on the same Pacific day,
  // the live readings are used for that day and the Publer readings are set aside.
  const timeline=[...snapshots,...live]
    .sort((a,b)=>Date.parse(a.captured_at)-Date.parse(b.captured_at)||(a.source===b.source?Number(a.id)-Number(b.id):a.source==="publer"?-1:1));
  const series:any[]=[];
  for(let d=range.from;d<=range.to;d=shiftDay(d,1))series.push({date:d,observed_views:null,observations:0,accounts:{}});
  const dayMap=new Map(series.map(d=>[d.date,d]));
  const previous=new Map<string,any>(),latestPub=new Map<string,any>(),latestLive=new Map<string,any>();
  const gains=new Map<string,number[]>(),coverage={missing_baselines:0,corrections:0,snapshots:0,posts_with_metrics:0,live_snapshots:0};
  const missing=new Set<string>(),counted=new Set<string>();
  type DayGains={phone_slot:string;live:number[];publer:number[];liveSeed?:number;publerSeed?:number};
  const byDay=new Map<string,Map<string,DayGains>>();
  for(const s of timeline){
    const key=keyOf(s),v=num(s.video_views),track=`${key}|${s.source}`,old=previous.get(track),day=ptNow(new Date(s.captured_at)).ymd;
    const published=s.source==="live"?s.posted_at:(s.raw?.scheduled_at??s.raw?.published_at);
    if(s.captured_at>=range.start){coverage.snapshots++;if(s.source==="live")coverage.live_snapshots++;}
    // A reading without a view count neither counts nor moves the baseline.
    if(v===null)continue;
    if(s.captured_at>=range.start&&dayMap.has(day)){
      const posts=byDay.get(day)??new Map<string,DayGains>();byDay.set(day,posts);
      const g=posts.get(key)??{phone_slot:s.phone_slot,live:[],publer:[]};posts.set(key,g);
      if(old){
        const delta=v-Number(old.video_views);
        // A downward correction is excluded and the higher baseline is kept, so climbing back
        // to an earlier value is not counted as new views.
        if(delta<0)coverage.corrections++;else{g[s.source as "live"|"publer"].push(delta);counted.add(key);}
      } else if(published&&Date.parse(published)>=Date.parse(range.start)&&Date.parse(published)<=Date.parse(s.captured_at)){
        // First reading of a post published inside the range: its whole count is new (used once per post).
        g[s.source==="live"?"liveSeed":"publerSeed"]=v;counted.add(key);
      } else missing.add(key);
    }
    if(!old||v>=Number(old.video_views))previous.set(track,s);
  }
  const seeded=new Set<string>();
  for(const d of series){
    for(const [key,g] of byDay.get(d.date)??[]){
      const src=g.live.length||g.liveSeed!==undefined?"live":"publer";
      const seed=src==="live"?g.liveSeed:g.publerSeed;
      const values=[...(seed!==undefined&&!seeded.has(key)?[seed]:[]),...g[src]];
      if(seed!==undefined)seeded.add(key);
      for(const delta of values){
        d.observed_views=(d.observed_views??0)+delta;d.observations++;
        d.accounts[g.phone_slot]=(d.accounts[g.phone_slot]??0)+delta;
        gains.set(g.phone_slot,[...(gains.get(g.phone_slot)??[]),delta]);
      }
    }
  }
  for(const s of snapshots)latestPub.set(keyOf(s),s);
  for(const s of live)latestLive.set(keyOf(s),s);
  coverage.missing_baselines=[...missing].filter(k=>!counted.has(k)).length;
  // Per-metric merge: the preferred source supplies each number; the other fills gaps
  // (for example Instagram shares and saves, which are not public, come from Publer).
  const merged=(key:string)=>{
    const L=latestLive.get(key),P=latestPub.get(key);
    if(!L&&!P)return null;
    const primary=L&&(!P||Date.parse(L.captured_at)>=Date.parse(P.captured_at)-LIVE_PREFERENCE_MS)?L:(P??L);
    const other=primary===L?P:L;let filled=false;
    const values=Object.fromEntries(metrics.map(k=>{let v=num(primary?.[k]);if(v===null&&other){v=num(other[k]);if(v!==null)filled=true;}return [k,v];}));
    return {values,captured_at:primary.captured_at,live_captured_at:L?.captured_at??null,publer_captured_at:P?.captured_at??null,
      metrics_source:primary===L?(filled?"live+publer":"live"):(filled?"publer+live":"publer"),
      link:safeLink(L?.post_link)??safeLink(P?.raw?.post_link)??safeLink(P?.publer_post_id),
      thumbnail:publerThumbnail(P?.raw),
      caption:P?.raw?.text??P?.raw?.caption??L?.caption??null,
      at:P?.raw?.scheduled_at??P?.raw?.published_at??L?.posted_at??null};
  };
  const lookup=(l:any)=>alias.get(`${l.phone_slot}|${l.publer_post_link}`)??alias.get(`${l.phone_slot}|${platformKey(l.publer_post_link)}`)??alias.get(`${l.phone_slot}|${l.publer_post_id}`)??null;
  const liveBySlot=new Map(liveAccounts.map(a=>[a.phone_slot,a]));
  const posts:any[]=[],postKeys=new Set<string>(),matched=new Set<string>();
  const empty={values:Object.fromEntries(metrics.map(k=>[k,null])),captured_at:null,live_captured_at:null,publer_captured_at:null,metrics_source:null,link:null,thumbnail:null,caption:null,at:null};
  for(const l of logs.filter(l=>l.status==="published")){
    const key=`${l.phone_slot}|${l.publer_post_id??l.publer_post_link??l.queue_id??`${l.slot_local_date}:${l.slot_index}`}`;
    if(postKeys.has(key))continue;postKeys.add(key);
    const k=lookup(l),m=(k&&merged(k))||empty;
    if(k)matched.add(k);
    const publishedAt=new Date(l.updated_at??l.attempted_at).toISOString(),acct=liveBySlot.get(l.phone_slot);
    // If the hourly public check ran successfully an hour or more after publishing and still could not
    // see this video, it is probably not publicly visible yet (for example under platform review).
    const visibility=m.live_captured_at?"public":acct?.last_pulled_at&&String(acct.last_status??"").startsWith("ok")&&
      Date.parse(acct.last_pulled_at)-Date.parse(publishedAt)>=3600_000?"not_found_publicly":null;
    posts.push({id:key,phone_slot:l.phone_slot,post_link:safeLink(l.publer_post_link)??m.link,
      published_at:publishedAt,caption:l.caption_used??m.caption,thumbnail:m.thumbnail,
      status:"published",recorded_by:"publisher",captured_at:m.captured_at,live_captured_at:m.live_captured_at,
      publer_captured_at:m.publer_captured_at,metrics_source:m.metrics_source,public_visibility:visibility,...m.values});
  }
  for(const key of new Set([...latestPub.keys(),...latestLive.keys()])){
    if(matched.has(key))continue;
    const m=merged(key)!,phone_slot=(latestPub.get(key)??latestLive.get(key)).phone_slot;
    if(!m.at||Date.parse(m.at)<Date.parse(range.start)||Date.parse(m.at)>=Date.parse(range.end))continue;
    posts.push({id:key,phone_slot,post_link:m.link,published_at:new Date(m.at).toISOString(),caption:m.caption,thumbnail:m.thumbnail,
      status:"provider_analytics",recorded_by:"analytics",captured_at:m.captured_at,live_captured_at:m.live_captured_at,
      publer_captured_at:m.publer_captured_at,metrics_source:m.metrics_source,public_visibility:m.live_captured_at?"public":null,...m.values});
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
      live:liveBySlot.has(s.phone_slot)?{username:liveBySlot.get(s.phone_slot).username,last_pulled_at:liveBySlot.get(s.phone_slot).last_pulled_at??null,
        ok:String(liveBySlot.get(s.phone_slot).last_status??"").startsWith("ok")}:null,
      not_found_publicly:own.filter(p=>p.public_visibility==="not_found_publicly").length,
      attempts:attempts.map(l=>({id:l.id,status:l.status,date:l.slot_local_date,slot_index:l.slot_index,
        planned_at:l.planned_at,at:l.attempted_at,error:l.error??null,post_link:safeLink(l.publer_post_link)}))};
  });
  return {range,checked_at:new Date().toISOString(),accounts,posts,series,coverage,
    totals:{accounts:accounts.length,published:accounts.reduce((n,a)=>n+a.published,0),
      attention:accounts.reduce((n,a)=>n+a.attention,0),attempts:logs.length,
      observed_views:sumKnown(accounts,"observed_views"),known_post_views:sumKnown(posts,"video_views"),
      latest_live_update:posts.map(p=>p.live_captured_at).filter(Boolean).sort().pop()??null,
      latest_publer_update:posts.map(p=>p.publer_captured_at).filter(Boolean).sort().pop()??null},
    notes:["View gains are changes observed between saved snapshots, attributed to the later capture day; not exact time-of-view events.",
      "Missing baselines and downward metric corrections are excluded. Unknown metrics are not zero.",
      "Video totals use the latest available snapshot before the selected range ends. Daily history is an as-of view, not today's lifetime total.",
      "Views, likes and comments refresh about hourly from public profile data; Publer's insights refresh about once a day and fill in reach, and Instagram shares and saves."]};
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
      const [r,lr,la]=await Promise.all([
        sb.rpc("dashboard_report_snapshots",{p_slots:ids,p_start:range.start,p_end:range.end}),
        sb.rpc("dashboard_live_snapshots",{p_slots:ids,p_start:range.start,p_end:range.end}),
        sb.from("live_metric_accounts").select("phone_slot,username,last_pulled_at,last_status").in("phone_slot",ids)]);
      if(r.error)throw r.error;
      // Live metrics are an enhancement: if they are unavailable the report still loads from Publer.
      const liveOk=!lr.error&&!la.error;
      if(!liveOk)console.warn("[report] live metrics unavailable:",lr.error?.message??la.error?.message);
      const result:any=buildReport(slots,logs,r.data??[],range,liveOk?(lr.data??[]):[],liveOk?(la.data??[]):[]);
      result.live_metrics=liveOk?"available":"unavailable";
      res.set("Cache-Control","private, no-store").json(result);
    }catch(e:any){res.status(/^invalid_date/.test(e.message)?400:503).json({error:/report_too_large/.test(e.message)?"report_too_large_choose_shorter_range":/^invalid_date/.test(e.message)?e.message:"report_unavailable"});}
  });
}
