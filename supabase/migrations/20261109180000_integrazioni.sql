-- Integrazioni dal pannello amministratore (chiavi in Vault):
-- Google Calendar (account di servizio + importazione appuntamenti) e WhatsApp Business (Cloud API di Meta).

create table if not exists gcal_imports (
  key text primary key,                       -- UID dell'evento | inizio dell'occorrenza
  source text not null, kind text not null, title text not null default '',
  booking_id bigint references bookings(id) on delete set null,
  block_id bigint references blocks(id) on delete set null,
  imported_by uuid default auth.uid(), imported_at timestamptz not null default now()
);
alter table gcal_imports enable row level security;
revoke all on table gcal_imports from anon, authenticated;

-- le prenotazioni importate non mandano la conferma WhatsApp all'allievo
create or replace function _on_booking_change() returns trigger language plpgsql security definer set search_path = public as $$
declare v_consent boolean;
begin
  select wa_consent into v_consent from students where id = new.student_id;
  if tg_op = 'INSERT' then
    insert into outbox(kind, booking_id) values ('cal_sync', new.id);
    if v_consent and new.source <> 'whatsapp' and coalesce(current_setting('app.silent', true), '') <> '1' then insert into outbox(kind, booking_id) values ('wa_confirm', new.id); end if;
  elsif new.status = 'annullata' and old.status = 'confermata' then
    insert into outbox(kind, booking_id) values ('cal_sync', new.id);
    if v_consent and coalesce(new.cancelled_by, '') <> 'whatsapp' then insert into outbox(kind, booking_id) values ('wa_cancel', new.id); end if;
  else
    return new;
  end if;
  perform _kick_worker();
  return new;
end $$;

-- segreti delle integrazioni: in Vault (in un ambiente di prova senza Vault, nelle impostazioni con prefisso dev_)
create or replace function _secret(p_name text) returns text language plpgsql stable security definer set search_path = public as $$
declare v text;
begin
  if to_regclass('vault.decrypted_secrets') is not null then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v using p_name;
    return nullif(v, '');
  end if;
  return nullif(_setting('dev_' || p_name), '');
end $$;

create or replace function _secret_set(p_name text, p_value text) returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if to_regclass('vault.secrets') is not null then
    execute 'select id from vault.secrets where name = $1' into v_id using p_name;
    if p_value is null then
      if v_id is not null then execute 'delete from vault.secrets where id = $1' using v_id; end if;
    elsif v_id is null then execute 'select vault.create_secret($1, $2)' using p_value, p_name;
    else execute 'select vault.update_secret($1, $2)' using v_id, p_value; end if;
  elsif p_value is null then delete from settings where key = 'dev_' || p_name;
  else insert into settings values ('dev_' || p_name, p_value) on conflict (key) do update set value = excluded.value;
  end if;
end $$;

create or replace function _set(p_key text, p_value text) returns void language sql security definer set search_path = public as $$
  insert into settings values (p_key, coalesce(p_value, '')) on conflict (key) do update set value = excluded.value
$$;
create or replace function _now_label() returns text language sql stable security definer set search_path = public as
$$ select to_char(now() at time zone _tz(), 'YYYY-MM-DD HH24:MI') $$;

-- ------------------------------------------------------------ Google Calendar
-- per ora in sola lettura: l'app legge gli appuntamenti; la scrittura su Google si accende con gcal_write = 'si'
insert into settings(key, value) values ('gcal_write', 'no') on conflict (key) do nothing;

create or replace function access_gcal_save(p_calendar_id text, p_sa_email text, p_key text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _secret_set('google_sa_key', p_key);
  perform _set('gcal_id', p_calendar_id); perform _set('gcal_sa_email', p_sa_email); perform _set('gcal_connected_at', _now_label());
end $$;

create or replace function access_gcal_clear() returns void language plpgsql security definer set search_path = public as $$
begin
  perform _secret_set('google_sa_key', null);
  delete from settings where key in ('gcal_id', 'gcal_sa_email', 'gcal_connected_at');
end $$;

-- ------------------------------------------------------------ WhatsApp Business (Cloud API di Meta)
create or replace function access_wa_save(p jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_verify text := _secret('wa_verify_token');
begin
  if v_verify is null then
    v_verify := replace(gen_random_uuid()::text, '-', '');
    perform _secret_set('wa_verify_token', v_verify);
  end if;
  perform _secret_set('wa_token', p->>'token');
  if nullif(p->>'app_secret', '') is not null then perform _secret_set('wa_app_secret', p->>'app_secret'); end if;
  perform _set('wa_phone_number_id', p->>'phone_number_id'); perform _set('wa_waba_id', p->>'waba_id'); perform _set('wa_app_id', p->>'app_id');
  perform _set('wa_display_number', p->>'display'); perform _set('wa_verified_name', p->>'name'); perform _set('wa_connected_at', _now_label());
  -- il numero della scuola per il pulsante "Prenota anche su WhatsApp", se non è già impostato
  if coalesce(_setting('whatsapp_number'), '') = '' and nullif(p->>'display', '') is not null then
    perform _set('whatsapp_number', regexp_replace(p->>'display', '[^0-9]', '', 'g'));
  end if;
  return jsonb_build_object('verify_token', v_verify);
end $$;

create or replace function access_wa_clear() returns void language plpgsql security definer set search_path = public as $$
begin
  perform _secret_set('wa_token', null); perform _secret_set('wa_app_secret', null);
  delete from settings where key in ('wa_phone_number_id', 'wa_waba_id', 'wa_app_id', 'wa_display_number', 'wa_verified_name', 'wa_connected_at');
end $$;

-- configurazione per le Edge Functions (solo service_role); i segreti impostati su Supabase hanno la precedenza
create or replace function worker_integrations() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g text := _secret('google_sa_key'); w text := _secret('wa_token');
begin
  return jsonb_build_object(
    'google', case when g is not null and nullif(_setting('gcal_id'), '') is not null then
      jsonb_build_object('calendar_id', _setting('gcal_id'), 'sa_email', _setting('gcal_sa_email'), 'private_key', g,
                         'write', coalesce(_setting('gcal_write'), 'no') = 'si') end,
    'wa', case when w is not null and nullif(_setting('wa_phone_number_id'), '') is not null then
      jsonb_build_object('token', w, 'phone_number_id', _setting('wa_phone_number_id'), 'waba_id', _setting('wa_waba_id'),
        'app_id', _setting('wa_app_id'), 'app_secret', _secret('wa_app_secret'), 'verify_token', _secret('wa_verify_token')) end,
    'project_url', _secret('project_url'));
end $$;

-- per l'anteprima: sale, insegnanti, allievi, cosa è già stato importato e quali eventi ha creato l'app
create or replace function access_gcal_lookup() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by sort, id) from rooms where active), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name) from teachers where active), '[]'),
    'students', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'email', email, 'phone', phone) order by name) from students where name <> ''), '[]'),
    'imported', coalesce((select jsonb_agg(key) from gcal_imports), '[]'),
    'app_events', coalesce((select jsonb_agg(gcal_event_id) from bookings where gcal_event_id is not null), '[]'),
    'today', _today())
$$;

-- importazione: ogni elemento diventa una lezione, un blocco di sala, un'assenza dell'insegnante o una chiusura
create or replace function access_gcal_import(p_items jsonb, p_user uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare it jsonb; v_as text; v_date date; v_h int; v_end int; v_min int; v_room bigint; v_tid bigint; v_sid bigint;
  v_title text; v_key text; r jsonb; v_bid bigint; v_blk bigint; v_ok int := 0; v_skip jsonb := '[]';
begin
  perform set_config('app.silent', '1', true);
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_as := it->>'as'; v_key := it->>'key'; v_title := left(coalesce(nullif(trim(it->>'title'), ''), 'Da Google Calendar'), 80);
    if v_as is null or v_as = 'salta' then continue; end if;
    if exists (select 1 from gcal_imports where key = v_key) then
      v_skip := v_skip || jsonb_build_object('title', v_title, 'date', it->>'date', 'reason', 'già importato'); continue;
    end if;
    begin
      v_date := (it->>'date')::date; v_h := coalesce((it->>'hour')::int, 0); v_end := coalesce((it->>'end_hour')::int, v_h + 1);
      v_min := coalesce((it->>'start_min')::int, 0);
      v_room := nullif(it->>'room_id', '')::bigint; v_tid := nullif(it->>'teacher_id', '')::bigint; v_sid := nullif(it->>'student_id', '')::bigint;
      v_bid := null; v_blk := null;
      if v_end <= v_h then v_end := v_h + 1; end if;
      if v_as = 'lezione' then
        if v_tid is null then perform _err('manca l''insegnante'); end if;
        if v_sid is null then perform _err('manca l''allievo'); end if;
        if v_room is null then   -- prima sala libera a quell'ora
          select r2.id into v_room from rooms r2 where r2.active
             and not exists (select 1 from bookings b where b.date = v_date and b.hour = v_h and b.room_id = r2.id and b.status = 'confermata')
             and not exists (select 1 from blocks x where x.date = v_date and v_h >= x.start_hour and v_h < x.end_hour and (x.room_id = r2.id or (x.room_id is null and x.teacher_id is null)))
           order by r2.sort, r2.id limit 1;
          if v_room is null then perform _err('nessuna sala libera a quell''ora'); end if;
        end if;
        r := _create_booking(v_date, v_h, v_room, v_tid, v_sid, 'Da Google Calendar: ' || v_title, 'segreteria', true, true);
        v_bid := (r->>'id')::bigint;
        update bookings set start_min = least(greatest(v_min, 0), 59), gcal_event_id = nullif(it->>'event_id', '') where id = v_bid;
      elsif v_as in ('sala', 'assenza', 'chiusura') then
        if v_as = 'sala' and v_room is null then perform _err('manca la sala'); end if;
        if v_as = 'assenza' and v_tid is null then perform _err('manca l''insegnante'); end if;
        if v_h < 0 or v_end > 24 then perform _err('orario non valido'); end if;
        insert into blocks(date, start_hour, end_hour, room_id, teacher_id, title, created_by)
          values (v_date, v_h, v_end, case when v_as = 'sala' then v_room end, case when v_as = 'assenza' then v_tid end, v_title, p_user)
          returning id into v_blk;
      else
        perform _err('tipo non valido');
      end if;
      insert into gcal_imports(key, source, kind, title, booking_id, block_id, imported_by)
        values (v_key, coalesce(it->>'source', 'google'), v_as, v_title, v_bid, v_blk, p_user);
      v_ok := v_ok + 1;
    exception when others then
      v_skip := v_skip || jsonb_build_object('title', v_title, 'date', it->>'date', 'hour', it->>'hour', 'reason', sqlerrm);
    end;
  end loop;
  perform _set('gcal_last_import', _now_label());
  return jsonb_build_object('imported', v_ok, 'skipped', v_skip);
end $$;

-- stato delle integrazioni per il pannello
create or replace function sa_integrations_status() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return jsonb_build_object(
    'google', jsonb_build_object(
      'connected', _secret('google_sa_key') is not null and nullif(_setting('gcal_id'), '') is not null,
      'calendar_id', _setting('gcal_id'), 'sa_email', _setting('gcal_sa_email'), 'connected_at', _setting('gcal_connected_at'),
      'write', coalesce(_setting('gcal_write'), 'no') = 'si',
      'last_import', _setting('gcal_last_import'), 'imported', (select count(*) from gcal_imports),
      'synced', (select count(*) from bookings where gcal_event_id is not null and status = 'confermata' and date >= _today()),
      'to_sync', (select count(*) from bookings where gcal_event_id is null and status = 'confermata' and date >= _today()),
      'errors', (select count(*) from bookings where sync_error is not null and status = 'confermata' and date >= _today()),
      'last_error', (select sync_error from bookings where sync_error is not null and date >= _today() order by id desc limit 1)),
    'wa', jsonb_build_object(
      'connected', _secret('wa_token') is not null and nullif(_setting('wa_phone_number_id'), '') is not null,
      'phone_number_id', _setting('wa_phone_number_id'), 'waba_id', _setting('wa_waba_id'), 'app_id', _setting('wa_app_id'),
      'display', _setting('wa_display_number'), 'name', _setting('wa_verified_name'), 'connected_at', _setting('wa_connected_at'),
      'has_app_secret', _secret('wa_app_secret') is not null, 'verify_token', _secret('wa_verify_token'),
      'webhook_url', coalesce(_secret('project_url'), '') || '/functions/v1/whatsapp-webhook',
      'pending', (select count(*) from outbox where kind like 'wa_%' and done_at is null) + (select count(*) from msg_outbox where kind like 'wl_%' and done_at is null),
      'errors', (select count(*) from outbox where kind like 'wa_%' and done_at is null and attempts > 0),
      'last_error', (select last_error from outbox where kind like 'wa_%' and last_error is not null order by id desc limit 1),
      'consents', (select count(*) from students where wa_consent)),
    'worker_last_run', _setting('worker_last_run'));
end $$;

-- copia su Google tutte le lezioni future non ancora presenti
create or replace function sa_gcal_resync() returns jsonb language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform _require_admin();
  insert into outbox(kind, booking_id)
    select 'cal_sync', id from bookings where status = 'confermata' and gcal_event_id is null and _slot_start(date, hour) > now();
  get diagnostics n = row_count;
  perform _kick_worker();
  return jsonb_build_object('ok', true, 'queued', n);
end $$;

revoke execute on function _secret(text), _secret_set(text, text), _set(text, text), _now_label(), access_gcal_save(text, text, text), access_gcal_clear(),
  access_wa_save(jsonb), access_wa_clear(), worker_integrations(), access_gcal_lookup(), access_gcal_import(jsonb, uuid) from public, anon, authenticated;
grant execute on function access_gcal_save(text, text, text), access_gcal_clear(), access_wa_save(jsonb), access_wa_clear(), worker_integrations(),
  access_gcal_lookup(), access_gcal_import(jsonb, uuid) to service_role;
revoke execute on function sa_integrations_status(), sa_gcal_resync() from public, anon;
grant execute on function sa_integrations_status(), sa_gcal_resync() to authenticated;
