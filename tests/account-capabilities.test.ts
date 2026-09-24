import test from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import { accountCapabilities } from "../src/account-capabilities.js";

const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
const req=(auth:unknown,profile:unknown)=>({auth,profile}) as Request;
test("capabilities grant only the designated operator with matching admin profile",()=>{
  assert.equal(accountCapabilities(req({user_id:OP},{user_id:OP,role:"admin"})).operate_accounts,true);
  for(const r of [
    req(null,null),req({admin_secret:true},{user_id:OP,role:"admin"}),
    req({user_id:OP},null),req({user_id:OP},{user_id:OP,role:"user"}),
    req({user_id:"other"},{user_id:"other",role:"admin",email:"support@tradvio.com"}),
    req({user_id:"other"},{user_id:OP,role:"admin"}),
    req({user_id:OP},{user_id:"other",role:"admin"}),
  ]) assert.equal(accountCapabilities(r).operate_accounts,false);
});
test("managed setup capability defaults off and requires the explicit environment gate",()=>{
  const original=process.env.MANAGED_PROVISIONING_ENABLED;
  try {
    for(const value of [undefined,"0","true","1"]) {
      if(value===undefined) delete process.env.MANAGED_PROVISIONING_ENABLED;
      else process.env.MANAGED_PROVISIONING_ENABLED=value;
      assert.equal(accountCapabilities(req(null,null)).managed_setup_enabled,value==="1");
    }
  } finally {
    if(original===undefined) delete process.env.MANAGED_PROVISIONING_ENABLED;
    else process.env.MANAGED_PROVISIONING_ENABLED=original;
  }
});
