import test from "node:test";
import assert from "node:assert/strict";
import {publishedIdentity} from "../src/publer-identity.js";
const sample={id:219632154,old_id:"6acb188ae22c90929b0df52f",account_id:"6a9d6b6dba4a5e4ef8280824",
  state:"published",account_type:"tiktok",post_id:"7695271349719272734",
  post_link:"https://www.tiktok.com/@tradvio/video/7695271349719272734?utm_campaign=tt4d_open_api"};
const parse=(s:any)=>publishedIdentity(s,sample.old_id,sample.account_id);
test("old and new provider IDs reconcile to an exact platform identity",()=>{
  const r=parse(sample);
  assert.equal(r.canonical_permalink,"https://www.tiktok.com/@tradvio/video/7695271349719272734");
  assert.equal(r.provider_post_id,"219632154");
  assert.equal(r.platform_post_id,sample.post_id);
  assert.equal(publishedIdentity(sample,"219632154",sample.account_id).legacy_post_id,sample.old_id);
});
test("foreign accounts, unknown IDs and unpublished posts never become labels",()=>{
  for(const delta of [{account_id:"foreign"},{old_id:"unrelated"},{state:"scheduled"},{post_id:"111"}])
    assert.throws(()=>parse({...sample,...delta}));
});
test("permalink validation rejects credentials, redirect hosts and insecure links",()=>{
  for(const url of ["http://www.tiktok.com/@tradvio/video/7695271349719272734",
    "https://www.tiktok.com.attacker.test/@tradvio/video/7695271349719272734",
    "https://user:pass@www.tiktok.com/@tradvio/video/7695271349719272734",
    "https://www.tiktok.com/@tradvio/video/111",null])
    assert.throws(()=>parse({...sample,post_link:url}));
});
