// Fresh normal Auth sign-ins, followed by GET-only API acceptance. No secret stdout.
import {readFileSync,writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {runChecks} from "./check-managed.mjs";
const root="/tmp/tradvio-staging-private";
const keys=JSON.parse(readFileSync(`${root}/keys.json`,"utf8"));
const users=JSON.parse(readFileSync(`${root}/users.json`,"utf8"));
const manifest=JSON.parse(readFileSync("staging/manifest.local.json","utf8"));
if(keys.project_ref!==manifest.project_ref||keys.project_ref!=="hjojeyewxtmunrwcjjzg")throw new Error("wrong_project");
const tokens={};
for(const [role,u] of Object.entries(users)) {
  const p=spawnSync("curl",["--silent","--show-error","--max-time","30","--fail",
    `https://${keys.project_ref}.supabase.co/auth/v1/token?grant_type=password`,
    "--header",`apikey: ${keys.anon_key}`,"--header","Content-Type: application/json","--data-binary","@-"],
    {input:JSON.stringify({email:u.email,password:u.password}),encoding:"utf8"});
  if(p.status!==0)throw new Error(`staging_sign_in_failed:${role}`);
  const session=JSON.parse(p.stdout);
  if(session.user?.id!==manifest.users[role])throw new Error(`identity_mismatch:${role}`);
  tokens[role]=session.access_token;
}
writeFileSync(`${root}/tokens.json`,JSON.stringify(tokens),{mode:0o600});
try {
  const result=await runChecks(manifest,tokens);
  writeFileSync("staging/acceptance-results.local.json",JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(e) {
  console.error(JSON.stringify({status:"failed",check:e.message}));
  process.exitCode=1;
}
