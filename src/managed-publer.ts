// Isolated future-scheduling adapter. Do not reuse the immediate legacy publisher.
const BASE="https://app.publer.com/api/v1";
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const fail=(code="receipt_unverified"):never=>{throw new Error(code);};
function id(v:any):string {return typeof v==="string"&&ID.test(v)?v:fail();}
function object(v:any) {return v && typeof v==="object"&&!Array.isArray(v);}
function clean(v:any) {
  if(v?.success===false||v?.plan?.locked===true)return fail();
  for(const key of ["failures","errors"]) {
    const e=v?.[key];
    if(e!==undefined&&e!==null
      && !(Array.isArray(e)&&e.length===0)
      && !(object(e)&&Object.keys(e).length===0))return fail();
  }
}
function unwrap(v:any):any {
  if(!object(v))return fail();
  clean(v);
  if(Object.hasOwn(v,"success")) {
    if(v.success!==true || !object(v.data))return fail();
    clean(v.data);
    return v.data;
  }
  return v;
}
function https(v:any):string {
  try {const u=new URL(v);if(typeof v!=="string"||v.length>4096||u.protocol!=="https:"||u.username||u.password) return fail();return v;}
  catch {return fail();}
}
export function mediaReceipt(payload:any):{id:string,path:string} {
  clean(payload);
  const v=payload?.media??payload;
  const m=Array.isArray(v)?(v.length===1?v[0]:fail()):v;
  return {id:id(m?.id),path:https(m?.path)};
}
export function postReceipt(payload:any,j:any):string {
  clean(payload);
  const v=payload?.posts??payload;
  const p=Array.isArray(v)?(v.length===1?v[0]?.post??v[0]:fail()):v?.post??v;
  if((p?.account_id??p?.account?.id)!==j.publer_account_id)return fail();
  return id(p?.id);
}
export function verifyPost(raw:any,j:any,now=Date.now()) {
  const v=unwrap(raw),p=v.post??v;
  if(p.id!==j.post_id || (p.account_id??p.account?.id)!==j.publer_account_id
    || !Number.isFinite(Date.parse(p.scheduled_at))
    || Date.parse(p.scheduled_at)!==Date.parse(j.scheduled_at)
    || p.text!==j.caption || !Array.isArray(p.media)||p.media.length!==1||p.media[0].id!==j.media?.id
    || !["scheduled","published","failed"].includes(p.state)
    || (p.state==="published"&&Date.parse(j.scheduled_at)>now+60000))return fail();
  return {post_id:id(p.id),account_id:j.publer_account_id,scheduled_at:j.scheduled_at,
    text:j.caption,media_id:j.media.id,state:p.state,
    ...(p.post_link?{post_link:https(p.post_link)}:{})};
}
export function publicationSettings(platform:string,v:any) {
  if(!object(v))return fail();
  const keys=platform==="instagram"?["feed"]:platform==="tiktok"?
    ["privacy","comment","duet","stitch","promotional","paid"]:[];
  if(!keys.length||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))
    || keys.some(k=>k==="privacy"?v[k]!=="PUBLIC_TO_EVERYONE":typeof v[k]!=="boolean"))return fail();
  return v;
}
export function scheduleBody(j:any,now=Date.now()) {
  id(j.publer_account_id);
  if(!["instagram","tiktok"].includes(j.platform)||typeof j.caption!=="string"
    ||j.caption.length<20||j.caption.length>800)return fail();
  if(!Number.isFinite(Date.parse(j.scheduled_at))||Date.parse(j.scheduled_at)<now+10*60000)return fail("slot_missed");
  const media=mediaReceipt(j.media);
  const settings=publicationSettings(j.platform,j.publication_settings);
  const details=j.platform==="instagram"?{type:"reel",...settings}:settings;
  return {bulk:{state:"scheduled",posts:[{
    networks:{[j.platform]:{type:"video",text:j.caption,media:[media],details}},
    accounts:[{id:j.publer_account_id,scheduled_at:new Date(j.scheduled_at).toISOString()}],
  }]}};
}
export function createManagedPubler(key:string,request:typeof fetch=fetch,now=Date.now) {
  if(!key)throw new Error("publer_configuration_required");
  async function call(workspace:string,path:string,body?:any,signal?:AbortSignal) {
    id(workspace);
    try {
      const r=await request(`${BASE}${path}`,{method:body?"POST":"GET",redirect:"error",
        signal:AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]),
        headers:{Authorization:`Bearer-API ${key}`,"Publer-Workspace-Id":workspace,
          Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
        ...(body?{body:JSON.stringify(body)}:{})});
      if(!r.ok) {await r.body?.cancel();return fail("provider_unavailable");}
      if(!r.body || Number(r.headers.get("content-length")??0)>1048576) {
        await r.body?.cancel();return fail();
      }
      const reader=r.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try {while(true) {const part=await reader.read();if(part.done)break;
        size+=part.value.length;if(size>1048576)return fail();chunks.push(part.value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }catch(e:any) {return fail(e?.message==="receipt_unverified"?"receipt_unverified":"provider_unavailable");}
  }
  return {
    async destination(j:any,signal?:AbortSignal) {
      const raw=await call(j.workspace_id,"/accounts",undefined,signal);
      const v=Array.isArray(raw)?raw:unwrap(raw).accounts;
      if(!Array.isArray(v))return fail("destination_unverified");
      const found=v.filter((a:any)=>a.id===j.publer_account_id);
      if(found.length!==1)return fail("destination_unverified");
      const a=found[0];
      if((a.provider??a.type)!==j.platform || a.needs_reauth===true || a.connected===false
        || a.status && !["active","connected"].includes(a.status))return fail("destination_unverified");
      // Inventory match is not a claim that provider tokens are healthy forever.
    },
    async calendar(j:any,signal?:AbortSignal) {
      // Explicit UTC bounds avoid an undocumented date-only workspace timezone.
      const at=Date.parse(j.scheduled_at);
      for(let page=0;page<3;page++) {
        const qs=new URLSearchParams({"account_ids[]":j.publer_account_id,
          from:new Date(at-86400000).toISOString(),to:new Date(at+86400000).toISOString(),page:String(page)});
        const raw=unwrap(await call(j.workspace_id,`/posts?${qs}`,undefined,signal));
        if(!Array.isArray(raw.posts)||!Number.isInteger(raw.total_pages)||raw.total_pages<0
          ||raw.total_pages>3||raw.page!==page || (raw.total_pages===0&&raw.posts.length))
          return fail("calendar_unverified");
        for(const p of raw.posts) {
          if((p.account_id??p.account?.id)!==j.publer_account_id)return fail("calendar_unverified");
          if(!Number.isFinite(Date.parse(p.scheduled_at)))return fail("calendar_unverified");
          if(Date.parse(p.scheduled_at)===Date.parse(j.scheduled_at))return fail("calendar_conflict");
        }
        if(page+1>=raw.total_pages)return;
      }
      return fail("calendar_unverified");
    },
    async upload(j:any,url:string,signal?:AbortSignal) {
      const r=unwrap(await call(j.workspace_id,"/media/from-url",{
        media:[{url:https(url),name:`managed-${id(j.id)}.mp4`}],type:"single",direct_upload:true,in_library:false,
      },signal));return id(r.job_id);
    },
    async schedule(j:any,signal?:AbortSignal) {
      const body=scheduleBody(j,now());
      const r=unwrap(await call(j.workspace_id,"/posts/schedule",body,signal));return id(r.job_id);
    },
    async job(workspace:string,jobId:string,signal?:AbortSignal) {
      const raw=unwrap(await call(workspace,`/job_status/${id(jobId)}`,undefined,signal));
      const v=object(raw.result)?raw.result:raw;
      clean(v);clean(v.payload);
      const status=v.status??raw.status;
      const canonical=(s:any)=>s==="completed"?"complete":s;
      if(v!==raw && raw.status && v.status && canonical(raw.status)!==canonical(v.status))return fail();
      if(!["working","pending","complete","completed","failed"].includes(status))return fail();
      return {status,payload:v.payload};
    },
    async post(j:any,signal?:AbortSignal) {
      return call(j.workspace_id,`/posts/${id(j.post_id)}`,undefined,signal);
    },
  };
}
export type ManagedPubler=ReturnType<typeof createManagedPubler>;
