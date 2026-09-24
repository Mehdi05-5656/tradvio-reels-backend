import {createHash} from "node:crypto";
export interface VideoPlan {
  version:1;angle:string;title:string;caption:string;audio:"source";
  segments:{start:number;duration:number;text:string}[];
}
const exact=(v:any,keys:string[])=>v && typeof v==="object" && !Array.isArray(v)
  && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
// Deliberately English/ASCII only in v1. Reject rather than silently drop glyphs.
const copy=(v:any,min:number,max:number)=>typeof v==="string" && v.trim().length>=min && v.length<=max
  && /^[A-Za-z0-9 .,!?':()%-]+$/.test(v) && !/(https?|www)[.:/]/i.test(v);
function lines(text:string) {
  let count=1,width=0;
  for(const word of text.split(" ")){if(width+word.length+1>26){count++;width=word.length;}
    else width+=(width?1:0)+word.length;}return count;
}
export function validatePlan(v:any,sourceDuration:number):VideoPlan {
  const bad=()=>{throw new Error("invalid_plan");};
  if(!exact(v,["version","angle","title","caption","audio","segments"]) || v.version!==1 || v.audio!=="source"
    || !copy(v.angle,20,180) || !copy(v.title,5,52) || !copy(v.caption,20,800)
    || !Array.isArray(v.segments) || v.segments.length<3 || v.segments.length>6) bad();
  let total=0;const ranges:[number,number][]=[];const texts=new Set<string>();
  for(const s of v.segments) {
    if(!exact(s,["start","duration","text"]) || !Number.isFinite(s.start) || !Number.isFinite(s.duration)
      || s.start<0 || s.duration<3 || s.duration>10 || s.start+s.duration>sourceDuration
      || !copy(s.text,8,78) || s.text.length/s.duration>18
      || s.text.split(" ").some((w:string)=>w.length>26) || lines(s.text)>3) bad();
    if(ranges.some(([lo,hi])=>s.start<hi && s.start+s.duration>lo)) bad();
    ranges.push([s.start,s.start+s.duration]);total+=s.duration;
    texts.add(s.text.trim().toLowerCase());
  }
  if(total<12 || total>45 || texts.size!==v.segments.length || v.title.split(" ").some((w:string)=>w.length>26)
    || lines(v.title)>2) bad();
  // Reconstruct canonical key order; model JSON ordering cannot evade exact hash.
  return {version:1,angle:v.angle.trim(),title:v.title.trim(),caption:v.caption.trim(),audio:"source",
    segments:v.segments.map((s:any)=>({start:s.start,duration:s.duration,text:s.text.trim()}))};
}
export const sha256=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex");
export function planIdentity(plan:VideoPlan) {
  const words=[plan.title,...plan.segments.map(s=>s.text),plan.caption].join(" ").toLowerCase().match(/[a-z0-9]+/g)??[];
  return {hash:sha256(JSON.stringify(plan)),tokens:[...new Set(words.slice(1).map((w,i)=>sha256(words[i]+" "+w)))].sort()};
}
