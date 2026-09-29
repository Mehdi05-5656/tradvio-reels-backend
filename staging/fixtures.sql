-- Synthetic staging fixtures only. Auth users must already exist via admin API.
BEGIN;
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM staging_environment WHERE singleton AND mode='managed-readonly-staging')
    OR EXISTS(SELECT 1 FROM managed_accounts)
    OR (SELECT count(*) FROM auth.users)<>4
    OR (SELECT count(*) FROM auth.users WHERE email IN (
      'operator@staging.tradvio.invalid','view_admin@staging.tradvio.invalid',
      'customer_a@staging.tradvio.invalid','customer_b@staging.tradvio.invalid'))<>4
    OR NOT EXISTS(SELECT 1 FROM auth.users WHERE id='71c2308a-9e23-4458-b4f0-df7ae53c841e'
      AND email='operator@staging.tradvio.invalid')
    THEN RAISE EXCEPTION 'synthetic_staging_preconditions_failed'; END IF;
END $$;
UPDATE profiles SET role='admin'
  WHERE email IN ('operator@staging.tradvio.invalid','view_admin@staging.tradvio.invalid');
DO $$
DECLARE customer record; platform_name text; workspace text; dest text; handle_name text;
  inv uuid; account uuid; batch uuid; generation uuid; handoff_state text; ordinal_num integer;
BEGIN
  FOR customer IN SELECT id,email FROM auth.users WHERE email IN
    ('customer_a@staging.tradvio.invalid','customer_b@staging.tradvio.invalid') LOOP
    workspace := 'staging-'||split_part(customer.email,'@',1);
    INSERT INTO managed_workspaces(workspace_id,customer_user_id,consent_ref,enabled)
      VALUES(workspace,customer.id,'SYNTHETIC TEST ONLY - no real consent or destination',false);
    FOREACH platform_name IN ARRAY ARRAY['instagram','tiktok'] LOOP
      dest := workspace||'-not-a-provider-'||platform_name;
      handle_name := 'staging_'||split_part(customer.email,'@',1)||'_'||platform_name;
      INSERT INTO managed_inventory(workspace_id,accounts)
        VALUES(workspace,jsonb_build_array(jsonb_build_object('id',dest,'platform',platform_name,'handle',handle_name)))
        RETURNING id INTO inv;
      INSERT INTO managed_accounts(customer_user_id,workspace_id,publer_account_id,platform,handle,
        inventory_id,policy,brand_inputs,rights_confirmed,state,blocked_reason,publishing_enabled)
        VALUES(customer.id,workspace,dest,platform_name,handle_name,inv,
          '{"timezone":"America/Los_Angeles","slot_times":["10:00","14:00"],"buffer_days":1}',
          '{"audience":"Synthetic test audience","voice":"Educational","language":"en","cta":"Test only"}',
          false,'blocked','rights_not_confirmed',false) RETURNING id INTO account;
      INSERT INTO managed_setup_jobs(account_id,state,finished_at) VALUES(account,'completed',now());
      INSERT INTO managed_blueprints(account_id,inputs) VALUES(account,'{"synthetic":true}');
      INSERT INTO managed_batches(account_id,target_count,blocked_reason)
        VALUES(account,3,'rights_not_confirmed') RETURNING id INTO batch;
      FOR ordinal_num IN 1..3 LOOP
        INSERT INTO managed_generation_jobs(batch_id,account_id,ordinal,state,error_code)
          VALUES(batch,account,ordinal_num,'blocked','generation_ineligible') RETURNING id INTO generation;
        handoff_state := CASE ordinal_num WHEN 1 THEN 'held' WHEN 2 THEN 'scheduled' ELSE 'published' END;
        INSERT INTO managed_handoffs(generation_id,account_id,customer_user_id,workspace_id,
          publer_account_id,platform,caption,artifact,timezone,local_date,local_time,scheduled_at,
          state,error_code,remote_review_required)
          VALUES(generation,account,customer.id,workspace,dest,platform_name,
            'SYNTHETIC display-only fixture, never publish','{"synthetic":true,"no_media":true}',
            'America/Los_Angeles',current_date,(9+ordinal_num)::text||':00',
            now()+ordinal_num*interval '1 hour',handoff_state,
            CASE WHEN ordinal_num=1 THEN 'provider_result_uncertain' ELSE NULL END,ordinal_num=1);
      END LOOP;
    END LOOP;
  END LOOP;
END $$;
COMMIT;
