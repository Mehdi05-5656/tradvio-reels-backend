const MODE="managed-readonly-staging",PROD="gzvxqzguthrpvjtflxcx";
const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const roles=["operator","view_admin","customer_a","customer_b"];
const uuid=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
function requireCheck(ok,name){if(!ok)throw new Error(name);}
export function validateManifest(m) {
  requireCheck(m&&m.schema_version===1&&m.mode===MODE,"invalid_manifest");
  const u=new URL(m.backend_origin);
  requireCheck(u.protocol==="https:"&&u.origin===m.backend_origin&&u.hostname.includes("staging")
    &&!u.username&&!u.password&&!u.port,"isolated_staging_origin_required");
  requireCheck(/^[a-z]{20}$/.test(m.project_ref)&&m.project_ref!==PROD,"isolated_staging_project_required");
  requireCheck(/^[a-f0-9]{40}$/.test(m.build_sha),"expected_revision_required");
  requireCheck(roles.every(r=>uuid(m.users?.[r]))&&new Set(roles.map(r=>m.users[r])).size===4
    &&m.users.operator===OP,"four_distinct_staging_identities_required");
  requireCheck(["customer_a","customer_b"].every(r=>Array.isArray(m.accounts?.[r])&&m.accounts[r].length>0
    &&m.accounts[r].length<=24&&m.accounts[r].every(uuid)),"account_inventory_required");
  const ids=[...m.accounts.customer_a,...m.accounts.customer_b];
  requireCheck(new Set(ids).size===ids.length,"duplicate_test_account");
  return m;
}
function validateTokens(m,tokens) {
  for(const role of roles) {
    let c;
    try {c=JSON.parse(Buffer.from(tokens[role].split(".")[1],"base64url").toString());}catch {}
    requireCheck(c&&c.sub===m.users[role]&&c.iss===`https://${m.project_ref}.supabase.co/auth/v1`
      &&c.aud==="authenticated"&&c.role==="authenticated"&&c.exp>Date.now()/1000+300,
      `staging_session_required:${role}`);
  }
  // This is only a local token-misdirection guard. The server verifies signatures.
}
export async function runChecks(manifest,tokens,transport=fetch) {
  const m=validateManifest(manifest);validateTokens(m,tokens);
  const passed=[];
  async function get(path,role,status=200) {
    const r=await transport(`${m.backend_origin}${path}`,{method:"GET",redirect:"error",
      headers:role?{Authorization:`Bearer ${tokens[role]??role}`}:{},signal:AbortSignal.timeout(15000)});
    requireCheck(r.status===status,`http_status:${role??"anonymous"}:${path.split("?")[0]}`);
    requireCheck(r.headers.get("x-staging-mode")===MODE,"staging_response_marker_required");
    requireCheck(r.headers.get("cache-control")==="private, no-store","private_no_store_required");
    let body;try {body=await r.json();}catch {throw new Error("json_response_required");}
    return body;
  }
  async function safety() {
    const s=await get("/api/staging/safety","operator");
    requireCheck(s.mode===MODE&&s.project_ref===m.project_ref&&s.build_sha===m.build_sha
      &&s.mutations_blocked===true&&s.workers_started===false&&s.provider_credentials_present===false,
      "staging_process_safety_unverified");
    const d=s.database;
    requireCheck(d&&d.managed_handoff_control===false&&d.managed_generation_control===false
      &&["enabled_accounts","enabled_approvals","unpaused_legacy_slots","remote_receipts",
        "active_handoff_leases","active_generation_leases"].every(k=>d[k]===0),"staging_database_safety_unverified");
    return d;
  }
  const before=await safety();passed.push("Process and database publishing gates are off");
  for(const role of roles) {
    const me=await get("/api/me",role);
    requireCheck(me.mode==="user"&&me.user_id===m.users[role]&&me.role===(role.startsWith("customer")?"user":"admin")
      &&me.capabilities?.operate_accounts===(role==="operator")&&me.capabilities?.managed_setup_enabled===true,
      `identity_or_capability_mismatch:${role}`);
  }
  passed.push("Four server-verified identities and exact operator capabilities");
  await get("/api/me",null,401);await get("/api/managed/accounts","invalid-staging-token",401);
  passed.push("Anonymous and invalid-token access denied");
  async function accountList(role,query="") {
    const rows=[],seen=new Set();let after="";
    for(let page=0;page<10;page++) {
      const body=await get(`/api/managed/accounts?${query}${after?`&after=${encodeURIComponent(after)}`:""}`,role);
      requireCheck(Array.isArray(body.accounts),"account_list_shape");
      rows.push(...body.accounts);
      if(body.next_cursor===null)return rows;
      requireCheck(uuid(body.next_cursor)&&!seen.has(body.next_cursor),"invalid_or_repeated_cursor");
      seen.add(body.next_cursor);after=body.next_cursor;
    }
    throw new Error("account_pagination_limit");
  }
  function assertAccounts(rows,role) {
    const own=role.startsWith("customer"),expected=own?m.accounts[role]:[...m.accounts.customer_a,...m.accounts.customer_b];
    requireCheck(rows.length===expected.length&&new Set(rows.map(r=>r.id)).size===rows.length
      &&rows.every(r=>expected.includes(r.id)&&r.publishing_enabled===false
        &&r.customer_user_id===m.users[m.accounts.customer_a.includes(r.id)?"customer_a":"customer_b"]),
      `account_isolation_failed:${role}`);
  }
  for(const role of roles)assertAccounts(await accountList(role),role);
  passed.push("Admin account union and separate customer account lists");
  for(const role of ["customer_a","customer_b"]) {
    const other=role==="customer_a"?"customer_b":"customer_a";
    assertAccounts(await accountList(role,`customer_user_id=${m.users[other]}&role=admin&user_id=${m.users[other]}`),role);
    for(const type of ["generation","handoffs"]) {
      for(const account of m.accounts[role]) {
        const b=await get(`/api/managed/${type}/${account}`,role);
        requireCheck(b.account_id===account&&b.publishing_enabled===false&&Array.isArray(b[type==="generation"?"jobs":"handoffs"]),
          `owned_status_shape:${type}`);
        const serialized=JSON.stringify(b);
        requireCheck(!/"(?:artifact|caption|workspace_id|lease_token|publer_account_id|customer_user_id|recipe|result)"\s*:/.test(serialized),
          `private_payload_leak:${type}`);
      }
      for(const account of m.accounts[other])await get(`/api/managed/${type}/${account}`,role,404);
      await get(`/api/managed/${type}/not-a-uuid`,role,400);
    }
    await get("/api/managed/accounts?after=not-a-uuid",role,400);
  }
  passed.push("Ownership parameter tampering and cross-customer generation/handoff reads denied");
  for(const role of ["operator","view_admin"]) {
    for(const account of [...m.accounts.customer_a,...m.accounts.customer_b]) {
      for(const type of ["generation","handoffs"]) {
        const b=await get(`/api/managed/${type}/${account}`,role);
        requireCheck(b.account_id===account&&b.publishing_enabled===false,"admin_status_mismatch");
      }
    }
  }
  const directory=await get("/api/admin/managed/customers","operator");
  requireCheck(Array.isArray(directory.customers)&&["customer_a","customer_b"].every(r=>
    directory.customers.some(c=>c.user_id===m.users[r])),"operator_directory_incomplete");
  for(const role of ["view_admin","customer_a","customer_b"])
    await get("/api/admin/managed/customers",role,403);
  passed.push("Viewing admin status access without operator customer-directory access");
  const after=await safety();
  requireCheck(JSON.stringify(before)===JSON.stringify(after),"staging_safety_changed_during_checks");
  passed.push("Final safety read confirms publishing remains disabled");
  return {mode:MODE,status:"passed",checked_at:new Date().toISOString(),checks:passed,
    limits:"Read-only API acceptance only; browser login/logout and database privilege checks remain separate."};
}
