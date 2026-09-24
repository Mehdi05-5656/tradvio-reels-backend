import {spawn} from "node:child_process";
import {writeFile,readFile,stat} from "node:fs/promises";
import {join} from "node:path";
import type {VideoPlan} from "./video-plan.js";

export async function command(bin:string,args:string[],signal?:AbortSignal,timeout=180000):Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{shell:false,stdio:["ignore","pipe","pipe"]});
    let bytes=0;const out:Buffer[]=[],errors:Buffer[]=[];let errorBytes=0;let killed=false;
    const kill=()=>{killed=true;child.kill("SIGKILL");};
    const timer=setTimeout(kill,timeout);const abort=()=>kill();signal?.addEventListener("abort",abort,{once:true});
    child.stdout.on("data",b=>{bytes+=b.length;if(bytes>8*1024*1024)kill();else out.push(b);});
    child.stderr.on("data",b=>{errorBytes+=b.length;if(errorBytes<256000)errors.push(b);else kill();});
    child.on("error",e=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);reject(e);});
    child.on("close",code=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);
      if(killed || code!==0)reject(new Error(killed?"process_aborted":"media_process_failed"));
      else resolve(Buffer.concat(out.length?out:errors));
    });
  });
}
const mediaInput=(path:string)=>["-protocol_whitelist","file,pipe","-enable_drefs","0","-use_absolute_path","0","-f","mov","-i",path];
async function probe(path:string,signal?:AbortSignal) {
  const raw=await command("ffprobe",["-v","error",...mediaInput(path),"-show_streams","-show_format","-of","json"],signal,30000);
  return JSON.parse(raw.toString());
}
export async function inspectSource(path:string,signal?:AbortSignal) {
  const p=await probe(path,signal),videos=p.streams.filter((s:any)=>s.codec_type==="video"),
    audio=p.streams.filter((s:any)=>s.codec_type==="audio"),v=videos[0];
  const duration=Number(p.format.duration);
  if(videos.length!==1 || audio.length!==1 || !["h264","hevc"].includes(v.codec_name)
    || !["aac","mp3"].includes(audio[0].codec_name) || v.width<160 || v.height<160
    || v.width>4096 || v.height>4096 || !Number.isFinite(duration) || duration<12 || duration>600
    || (await stat(path)).size>134217728 || Number(audio[0].channels)>2) throw new Error("source_invalid");
  return {duration};
}
export async function sampleSourceFrames(path:string,duration:number,signal?:AbortSignal) {
  const frames:{at:number;base64:string}[]=[];
  for(let i=0;i<8;i++) {
    const at=Number(((i+0.5)*duration/8).toFixed(2));
    const bytes=await command("ffmpeg",["-v","error","-ss",String(at),...mediaInput(path),
      "-frames:v","1","-vf","scale=640:640:force_original_aspect_ratio=decrease",
      "-f","image2pipe","-vcodec","mjpeg","-"],signal,15000);
    frames.push({at,base64:bytes.toString("base64")});
  }
  return frames;
}
function wrap(text:string,width=26) {
  const lines=[""];for(const w of text.split(" ")) {
    if(lines[lines.length-1].length+w.length+1>width)lines.push(w);
    else lines[lines.length-1]+=(lines[lines.length-1]?" ":"")+w;
  }return lines.join("\n");
}
export async function renderVideo(source:string,plan:VideoPlan,dir:string,signal?:AbortSignal) {
  // All file names are generated locally, never accepted from a model.
  const title=join(dir,"title.txt");await writeFile(title,wrap(plan.title));
  const font="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const n=plan.segments.length;
  const filters=[`[0:v]split=${n}${plan.segments.map((_,i)=>`[vi${i}]`).join("")}`,
    `[0:a]asplit=${n}${plan.segments.map((_,i)=>`[ai${i}]`).join("")}`];
  for(let i=0;i<n;i++) {
    const s=plan.segments[i],text=join(dir,`segment-${i}.txt`);await writeFile(text,wrap(s.text));
    // Sandboxed generated directory is restricted to a filter-safe path.
    if(!/^[A-Za-z0-9_./-]+$/.test(text))throw new Error("render_failed");
    filters.push(`[vi${i}]trim=start=${s.start}:duration=${s.duration},setpts=PTS-STARTPTS,`+
      "scale=720:960:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,"+
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x0c1424,fps=30,format=yuv420p,"+
      `drawtext=fontfile=${font}:textfile=${title}:expansion=none:fontcolor=white:fontsize=36:line_spacing=8:x=(w-text_w)/2:y=70,`+
      `drawtext=fontfile=${font}:textfile=${text}:expansion=none:fontcolor=white:fontsize=38:line_spacing=8:x=(w-text_w)/2:y=1080[v${i}]`);
    filters.push(`[ai${i}]atrim=start=${s.start}:duration=${s.duration},asetpts=PTS-STARTPTS,aresample=48000[a${i}]`);
  }
  filters.push(`${plan.segments.map((_,i)=>`[v${i}][a${i}]`).join("")}concat=n=${n}:v=1:a=1[v][mixed]`);
  filters.push("[mixed]loudnorm=I=-16:TP=-1.5:LRA=11[a]");
  const output=join(dir,"output.mp4");
  await command("ffmpeg",["-v","error","-nostdin","-threads","2",...mediaInput(source),
    "-filter_complex_threads","1","-filter_complex",filters.join(";"),"-map","[v]","-map","[a]",
    "-c:v","libx264","-threads","2","-preset","veryfast","-crf","22","-c:a","aac","-ar","48000",
    "-b:a","128k","-movflags","+faststart","-map_metadata","-1","-t",String(plan.segments.reduce((n,s)=>n+s.duration,0)),
    "-fs","67108864","-y",output],signal);
  return output;
}
export async function qualityCheck(path:string,expected:number,dir:string,signal?:AbortSignal) {
  const p=await probe(path,signal),v=p.streams.find((s:any)=>s.codec_type==="video"),
    a=p.streams.find((s:any)=>s.codec_type==="audio"),duration=Number(p.format.duration);
  if(!v || !a || v.width!==720 || v.height!==1280 || v.codec_name!=="h264" || v.pix_fmt!=="yuv420p"
    || a.codec_name!=="aac" || v.avg_frame_rate!=="30/1" || !Number.isFinite(duration)
    || Math.abs(duration-expected)>0.2 || (await stat(path)).size>=67108864)throw new Error("quality_failed");
  // -xerror decodes every frame, not just the first image/container header.
  await command("ffmpeg",["-v","error","-xerror",...mediaInput(path),"-f","null","-"],signal);
  const audio=(await command("ffmpeg",["-hide_banner",...mediaInput(path),"-vn","-af","volumedetect",
    "-f","null","-"],signal)).toString();
  const mean=audio.match(/mean_volume: ([\-\d.]+) dB/),peak=audio.match(/max_volume: ([\-\d.]+) dB/);
  if(!mean || !peak || Number(mean[1])< -40 || Number(peak[1])> -0.1)throw new Error("quality_failed");
  const fingerprints:string[]=[],frames:string[]=[];
  for(let i=0;i<8;i++) {
    const at=(i+0.5)*duration/8;
    const pixels=await command("ffmpeg",["-v","error","-ss",String(at),...mediaInput(path),"-frames:v","1",
      "-vf","crop=720:960:0:160,scale=9:8,format=gray","-f","rawvideo","-"],signal,15000);
    if(pixels.length!==72)throw new Error("quality_failed");
    const avg=pixels.reduce((a,b)=>a+b,0)/72;
    const variance=pixels.reduce((a,b)=>a+(b-avg)**2,0)/72;
    if(avg<8 || avg>247 || variance<12)throw new Error("quality_failed");
    let hash="";for(let y=0;y<8;y++)for(let x=0;x<8;x++)hash+=pixels[y*9+x]>pixels[y*9+x+1]?"1":"0";
    fingerprints.push(hash);
    if(i%2===0) {
      const frame=join(dir,`review-${i}.jpg`);
      await command("ffmpeg",["-v","error","-ss",String(at),...mediaInput(path),"-frames:v","1","-vf","scale=360:640","-y",frame],signal,15000);
      frames.push((await readFile(frame)).toString("base64"));
    }
  }
  return {technical_pass:true as const,duration,mean_db:Number(mean[1]),peak_db:Number(peak[1]),fingerprints,frames};
}
