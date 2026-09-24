import {readFile} from "node:fs/promises";
import {runChecks} from "./check-managed.mjs";
try {
  const manifest=JSON.parse(await readFile(process.argv[2]??"staging/manifest.local.json","utf8"));
  const roles=["operator","view_admin","customer_a","customer_b"];
  const tokens=Object.fromEntries(roles.map(r=>[r,process.env[`STAGING_JWT_${r.toUpperCase()}`]]));
  console.log(JSON.stringify(await runChecks(manifest,tokens),null,2));
}catch {
  // Never echo raw network errors, manifests, JWTs or API bodies.
  console.error(JSON.stringify({status:"blocked_or_failed",message:"Staging checks did not pass. Verify the non-secret configuration and safety gates before retrying."}));
  process.exitCode=1;
}
