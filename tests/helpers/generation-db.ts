import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
export const OP="71c2308a-9e23-4458-b4f0-df7ae53c841e";
export const A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const B="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export async function generationDb(t:any) {
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
    CREATE TABLE profiles(user_id uuid PRIMARY KEY REFERENCES auth.users,role text,display_name text);
    CREATE TABLE publer_config(id text PRIMARY KEY,workspace_id text);
    CREATE TABLE publer_slot_config(phone_slot text PRIMARY KEY,publer_account_id text,paused boolean);
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
    ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA storage TO anon,authenticated,service_role;
    GRANT ALL ON storage.objects TO anon,authenticated,service_role;
    CREATE POLICY existing_broad_policy ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);
    INSERT INTO publer_config VALUES('main','legacy');
    INSERT INTO publer_slot_config VALUES('phone_a','legacy-account',false);
    INSERT INTO auth.users(id,email_confirmed_at) VALUES('${OP}',now()),('${A}',now()),('${B}',now());
    INSERT INTO profiles VALUES('${OP}','admin','Operator'),('${A}','user','A'),('${B}','user','B');
    GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
  `);
  for(const file of ["20260924001500_managed_provisioning.sql","20260924010000_managed_generation.sql"]) {
    const sql=await readFile(`migrations/${file}`,"utf8"); await db.exec(sql); await db.exec(sql);
  }
  async function rpc(name:string,args:Record<string,any>={}) {
    const keys=Object.keys(args);
    const r=await db.query<any>(`SELECT ${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(",")}) AS value`,
      Object.values(args).map((v,i)=>keys[i]==="p_tokens"?`{${v.join(",")}}`:v&&typeof v==="object"?JSON.stringify(v):v));
    return r.rows[0].value;
  }
  async function account(customer=A,destination="account-a") {
    const workspace=`workspace-${customer[0]}`;
    await rpc("managed_register_workspace",{p_actor:OP,p_customer:customer,p_workspace:workspace,p_consent_ref:"consent-123"});
    const inv=await rpc("managed_record_inventory",{p_actor:OP,p_workspace:workspace,p_accounts:[{id:destination,platform:"instagram",handle:"test-account"}]});
    const id=await rpc("managed_assign_account",{p_actor:OP,p_customer:customer,p_workspace:workspace,p_inventory:inv,
      p_account:destination,p_key:`request-${destination}`,p_policy:{timezone:"UTC",slot_times:["10:00"],buffer_days:1},
      p_brand:{audience:"Beginning investors",voice:"Educational",language:"en",cta:"Learn more"},p_rights:true});
    await rpc("managed_provision_pending",{p_limit:5});return id;
  }
  const adapter:any={rpc:async(name:string,args:any)=>{try{return {data:await rpc(name,args),error:null};}catch(error){return {data:null,error};}}};
  return {db,rpc,account,adapter};
}
