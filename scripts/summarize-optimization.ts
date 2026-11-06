import {readFile,writeFile} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {resolve,basename} from "node:path";
import {parseArgs} from "node:util";
import {root} from "../src/upstream.js";
import {isToolFailure} from "../src/tool-audit.js";
const {positionals,values}=parseArgs({allowPositionals:true,options:{output:{type:"string",default:"results/mcp-optimization.json"},revision:{type:"string"}}});
if(!positionals.length||!values.revision)throw new Error("Provide --revision SOURCE_COMMIT and one or more trial directories");
const path=resolve(values.output!);
const report=await readFile(path,"utf8").then(JSON.parse,()=>({schema_version:1,clock:"realtime",record_video:false,note:"Preserve every attempt. Development seed 42; held-out seeds 2026 and 7 were fixed before selection.",attempts:[]}));
const median=(values:number[])=>{const a=[...values].sort((a,b)=>a-b);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.ceil((a.length-1)/2)])/2:null;};
for(const directory of positionals){
  const dir=resolve(directory),result=JSON.parse(await readFile(resolve(dir,"result.json"),"utf8")),meta=JSON.parse(await readFile(resolve(dir,"metadata.json"),"utf8"));
  for(const file of meta.source_files){
    const bytes=execFileSync("git",["show",`${values.revision}:${file.path}`],{cwd:root,maxBuffer:2*1024*1024});
    if(createHash("sha256").update(bytes).digest("hex")!==file.sha256)throw new Error(`Recorded source differs from ${values.revision}: ${file.path}`);
  }
  const trace=(await readFile(resolve(dir,"game/trace.jsonl"),"utf8")).trim().split("\n").map(x=>JSON.parse(x));
  const paths=trace.filter(x=>x.type==="path_finished"),starts=trace.filter(x=>x.type==="path_started"),observations=trace.filter(x=>x.type==="observation_wait");
  const events=(await readFile(resolve(dir,"events.jsonl"),"utf8")).split("\n").flatMap(x=>{try{return[JSON.parse(x)];}catch{return[];}});
  const errors=events.filter(x=>x.type==="item.completed"&&x.item?.type==="mcp_tool_call"&&isToolFailure(x.item));
  const entry={trial_id:basename(dir),interface:result.interface,seed:result.seed,policy:meta.policy??"baseline",mcp_profile:meta.mcp_profile??"standard",feedback:meta.feedback??"full",model:result.model,reasoning_effort:result.reasoning_effort,
    source_commit:values.revision,started_at:meta.started_at,record_video:meta.record_video,completed_round:result.completed_round,valid_interface:result.valid_interface,clock_valid:result.clock_valid,
    score:result.final_scene.stats.score,stats:result.final_scene.stats,tool_calls:result.tool_calls,tool_errors:errors.length,
    round_wall_ms:result.final_scene.clock_audit.finished_wall_elapsed_ms,maximum_clock_drift_ms:result.maximum_telemetry_clock_drift_ms,
    path_metrics:{count:paths.length,paths_with_hits:paths.filter(x=>x.result.events.some((e:any)=>e.type==="fruit_sliced")).length,median_requested_ms:median(starts.map(x=>x.input.points.at(-1).t_ms)),median_actual_ms:median(paths.map(x=>x.result.actual_duration_ms)),execution_ms:paths.reduce((a,x)=>a+x.result.actual_duration_ms,0),execution_fraction:paths.reduce((a,x)=>a+x.result.actual_duration_ms,0)/(result.duration_seconds*1000),median_observation_age_ms:median(paths.map(x=>x.result.observed_age_ms).filter((x:any)=>x!==null)),observation_wait_ms:observations.reduce((a,x)=>a+x.result.waited_ms,0)},
    raw_artifacts_directory:directory,upstream:meta.upstream,instrumented_game_sha256:trace[0].instrumented_game_sha256,source_files:meta.source_files,usage:result.usage};
  if(report.attempts.some((x:any)=>x.trial_id===entry.trial_id))throw new Error(`Already summarized: ${entry.trial_id}`);
  report.attempts.push(entry);console.log(entry.trial_id,entry.score,entry.path_metrics);
}
await writeFile(path,JSON.stringify(report,null,2)+"\n");
