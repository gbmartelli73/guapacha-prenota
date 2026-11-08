-- Avvio automatico del worker (notifiche, calendari, promemoria)
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Segreti in Vault: indirizzo del progetto e segreto casuale del worker (generato qui, non esce dal database).
-- Se riusi questo file per un altro progetto, cambia l'indirizzo qui sotto.
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'project_url') then
    perform vault.create_secret('https://iishadgubdwnmxxgppyp.supabase.co', 'project_url');
  end if;
  if not exists (select 1 from vault.secrets where name = 'worker_secret') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'worker_secret');
  end if;
end $$;

-- Il worker verifica qui il segreto ricevuto (solo service_role)
create or replace function worker_auth(p_secret text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(p_secret, '') <> '' and exists (select 1 from vault.decrypted_secrets where name = 'worker_secret' and decrypted_secret = p_secret)
$$;
revoke execute on function worker_auth(text) from public, anon, authenticated;
grant execute on function worker_auth(text) to service_role;

select cron.unschedule(jobid) from cron.job where jobname = 'scuola-worker';
select cron.schedule('scuola-worker', '* * * * *', $$ select public._kick_worker() $$);

select cron.unschedule(jobid) from cron.job where jobname = 'scuola-pulizia';
select cron.schedule('scuola-pulizia', '17 3 * * *', $$
  delete from net._http_response where created < now() - interval '3 days';
  delete from cron.job_run_details where end_time < now() - interval '3 days';
  delete from public.outbox where done_at < now() - interval '60 days';
$$);
