import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {handoffDb} from "./helpers/handoff-db.js";
test("read-only staging SQL audit flags active legacy slots and verifies browser-role restrictions",async t=>{
  const s=await handoffDb(t);
  const sql=await readFile("staging/database-audit.sql","utf8");
  const first=await s.db.exec(sql);
  const safety=first.flatMap(r=>r.rows as any[]).filter(r=>r.check_name);
  assert.equal(safety.length,8);
  assert.equal(safety.find(r=>r.check_name==="no_active_legacy_publishers").passed,false);
  // Local in-memory fixture only, not a connected project.
  await s.db.exec("UPDATE publer_slot_config SET paused=true");
  const clean=(await s.db.exec(sql)).flatMap(r=>r.rows as any[]);
  assert.ok(clean.filter(r=>r.check_name).every(r=>r.passed));
  const tables=clean.filter(r=>r.relname);
  assert.ok(tables.length>=10);
  assert.ok(tables.every(r=>r.relrowsecurity===true&&!r.anon_has_any_access&&!r.customer_has_any_access));
  const functions=clean.filter(r=>r.signature);
  assert.ok(functions.length>=10);
  assert.ok(functions.every(r=>!r.anon_can_execute&&!r.customer_can_execute));
});
