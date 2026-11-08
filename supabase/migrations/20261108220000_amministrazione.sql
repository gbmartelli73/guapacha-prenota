-- Pannello amministratore: ruolo admin, gestione utenze (admin, segreteria, insegnanti, allievi) e statistiche dell'app.
-- L'utente "admin" accede con nome utente (admin → admin@guapacha.invalid) e al primo accesso deve cambiare la password.

create table if not exists admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);
alter table admins enable row level security;
revoke all on table admins from anon, authenticated;

alter table staff add column if not exists name text not null default '';

create or replace function is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from admins where user_id = auth.uid()) $$;

-- l'amministratore può usare anche il pannello della segreteria
create or replace function is_staff() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from staff where user_id = auth.uid()) or exists (select 1 from admins where user_id = auth.uid() and not must_change_password) $$;

create or replace function access_is_staff(p_uid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from staff where user_id = p_uid) or exists (select 1 from admins where user_id = p_uid and not must_change_password) $$;

create or replace function _require_admin() returns void language plpgsql stable security definer set search_path = public as $$
declare a admins;
begin
  select * into a from admins where user_id = auth.uid();
  if not found then perform _err('Accesso riservato all''amministratore.'); end if;
  if a.must_change_password then perform _err('Prima di continuare scegli una nuova password.'); end if;
end $$;

-- chi sono (per la schermata di accesso del pannello)
create or replace function sa_me() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a admins;
begin
  select * into a from admins where user_id = auth.uid();
  return jsonb_build_object('admin', found, 'must_change_password', coalesce(a.must_change_password, false),
    'email', (select email from auth.users where id = auth.uid()), 'school', _setting('school_name'), 'today', _today());
end $$;

-- ------------------------------------------------------------ elenco utenze
create or replace function _user_role(p_uid uuid) returns text language sql stable security definer set search_path = public as $$
  select case when exists (select 1 from admins where user_id = p_uid) then 'admin'
              when exists (select 1 from staff where user_id = p_uid) then 'segreteria'
              when exists (select 1 from teachers where user_id = p_uid) then 'insegnante'
              when exists (select 1 from students where user_id = p_uid) then 'allievo'
              else 'nessuno' end
$$;

create or replace function sa_users() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_admin();
  return jsonb_build_object(
    'accounts', coalesce((select jsonb_agg(x order by x->>'role', x->>'name') from (
       select jsonb_build_object('user_id', u.id, 'email', u.email, 'phone', u.phone, 'role', _user_role(u.id),
         'name', coalesce(nullif(st.name, ''), t.name, s.name, u.raw_user_meta_data->>'name', ''),
         'teacher_id', t.id, 'student_id', s.id, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
         'banned', coalesce(u.banned_until > now(), false), 'me', u.id = auth.uid(),
         'must_change_password', coalesce(a.must_change_password, false)) x
       from auth.users u
       left join admins a on a.user_id = u.id
       left join staff st on st.user_id = u.id
       left join teachers t on t.user_id = u.id
       left join students s on s.user_id = u.id
       where u.deleted_at is null) q), '[]'),
    'students', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'phone', s.phone, 'email', s.email,
         'member_no', s.member_no, 'member_until', s.member_until, 'created_at', s.created_at, 'user_id', s.user_id,
         'login_email', u.email, 'last_sign_in_at', u.last_sign_in_at, 'banned', coalesce(u.banned_until > now(), false),
         'lessons', (select count(*) from bookings b where b.student_id = s.id and b.status = 'confermata'),
         'wa_consent', s.wa_consent) order by s.name)
       from students s left join auth.users u on u.id = s.user_id), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'style', t.style, 'active', t.active,
         'login_email', (select email from auth.users u where u.id = t.user_id)) order by t.active desc, t.name) from teachers t), '[]'));
end $$;

-- ------------------------------------------------------------ funzioni usate solo dalla Edge Function "amministrazione"
create or replace function access_admin_state(p_uid uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('admin', a.user_id is not null, 'must_change_password', coalesce(a.must_change_password, false),
                            'admins', (select count(*) from admins), 'role', _user_role(p_uid))
  from (select p_uid as id) x left join admins a on a.user_id = x.id
$$;

create or replace function access_user_by_phone(p_phone text) returns uuid language sql stable security definer set search_path = public as
$$ select id from auth.users where phone = _norm_phone(p_phone) limit 1 $$;

create or replace function access_norm_phone(p_phone text) returns text language sql stable security definer set search_path = public as
$$ select _norm_phone(p_phone) $$;

create or replace function access_pw_changed(p_uid uuid) returns void language sql security definer set search_path = public as
$$ update admins set must_change_password = false where user_id = p_uid $$;

-- toglie ogni ruolo a un utente (l'anagrafica dell'allievo e le sue lezioni restano)
create or replace function access_unlink_all(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from admins where user_id = p_user;
  delete from staff where user_id = p_user;
  update teachers set user_id = null where user_id = p_user;
  update students set user_id = null where user_id = p_user;
end $$;

-- assegna il ruolo a un utente appena creato (o già esistente)
create or replace function access_assign(p_user uuid, p_role text, p_name text default '', p_teacher bigint default null,
  p_new_teacher text default null, p_style text default '', p_phone text default null, p_email text default null, p_wa boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_tid bigint; v_sid bigint; v_phone text;
begin
  p_name := left(trim(coalesce(p_name, '')), 80);
  if p_role = 'admin' then
    if exists (select 1 from students where user_id = p_user) then perform _err('Questo account appartiene a un allievo.'); end if;
    insert into admins(user_id, must_change_password) values (p_user, true) on conflict do nothing;
    if p_user is not null and p_name <> '' then
      update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}') || jsonb_build_object('name', p_name) where id = p_user;
    end if;
  elsif p_role = 'segreteria' then
    if exists (select 1 from students where user_id = p_user) then perform _err('Questo account appartiene a un allievo.'); end if;
    insert into staff(user_id, name) values (p_user, p_name) on conflict (user_id) do update set name = excluded.name;
  elsif p_role = 'insegnante' then
    if exists (select 1 from students where user_id = p_user) then perform _err('Questo account appartiene a un allievo.'); end if;
    if p_teacher is null then
      if length(trim(coalesce(p_new_teacher, ''))) < 2 then perform _err('Scegli l''insegnante o scrivi il nome del nuovo insegnante.'); end if;
      insert into teachers(name, style) values (left(trim(p_new_teacher), 60), left(trim(coalesce(p_style, '')), 60)) returning id into v_tid;
    else
      if not exists (select 1 from teachers where id = p_teacher) then perform _err('Insegnante non trovato.'); end if;
      v_tid := p_teacher;
    end if;
    update teachers set user_id = null where user_id = p_user and id <> v_tid;
    update teachers set user_id = p_user where id = v_tid;
    return jsonb_build_object('ok', true, 'teacher_id', v_tid);
  elsif p_role = 'allievo' then
    v_phone := _norm_phone(p_phone);
    if length(p_name) < 2 then perform _err('Scrivi nome e cognome dell''allievo.'); end if;
    if p_user is not null and (exists (select 1 from staff where user_id = p_user) or exists (select 1 from admins where user_id = p_user)
                               or exists (select 1 from teachers where user_id = p_user)) then
      perform _err('Questo account appartiene già alla segreteria o a un insegnante.');
    end if;
    insert into students(phone, name, email, wa_consent, user_id)
      values (v_phone, p_name, nullif(lower(trim(coalesce(p_email, ''))), ''), coalesce(p_wa, false), p_user)
      on conflict (phone) do update set name = excluded.name,
        email = coalesce(excluded.email, students.email), wa_consent = students.wa_consent or excluded.wa_consent,
        user_id = coalesce(excluded.user_id, students.user_id)
      returning id into v_sid;
    return jsonb_build_object('ok', true, 'student_id', v_sid);
  else
    perform _err('Ruolo non valido.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------ statistiche (insights)
create or replace function sa_insights(p_days int default 30) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_days int := least(greatest(coalesce(p_days, 30), 7), 366);
  v_to date := _today();
  v_from date := _today() - (least(greatest(coalesce(p_days, 30), 7), 366) - 1);
  v_pfrom date := _today() - 2 * (least(greatest(coalesce(p_days, 30), 7), 366)) + 1;
  v_pto date := _today() - least(greatest(coalesce(p_days, 30), 7), 366);
  v_ppl int := coalesce(_setting_int('points_per_lesson'), 10);
  r jsonb;
begin
  perform _require_admin();

  with
  bk as (select b.*, _slot_start(b.date, b.hour) as starts from bookings b),
  cur as (select * from bk where date between v_from and v_to),
  prev as (select * from bk where date between v_pfrom and v_pto),
  days as (select d::date as d from generate_series(v_from, v_to, interval '1 day') d),
  slots as (
    select dd.d, h, r.id as room_id from days dd cross join lateral unnest(_opening_hours(dd.d)) h cross join rooms r
     where r.active and not exists (select 1 from blocks x where x.date = dd.d and h >= x.start_hour and h < x.end_hour
                                     and (x.room_id = r.id or (x.room_id is null and x.teacher_id is null)))),
  tslots as (
    select dd.d, h, t.id as teacher_id from days dd cross join teachers t
      join shifts sh on sh.teacher_id = t.id and sh.weekday = extract(dow from dd.d)::int
      cross join lateral generate_series(sh.start_hour, sh.end_hour - 1) h
     where t.active and h = any(_opening_hours(dd.d))
       and not exists (select 1 from blocks x where x.date = dd.d and h >= x.start_hour and h < x.end_hour
                        and (x.teacher_id = t.id or (x.room_id is null and x.teacher_id is null)))),
  weeks as (select (date_trunc('week', v_to::timestamp) - (n || ' weeks')::interval)::date as w from generate_series(0, 11) n)
  select jsonb_build_object(
    'period', jsonb_build_object('days', v_days, 'from', v_from, 'to', v_to, 'prev_from', v_pfrom, 'prev_to', v_pto),
    'kpi', jsonb_build_object(
      'lessons', (select count(*) from cur where status = 'confermata'),
      'lessons_prev', (select count(*) from prev where status = 'confermata'),
      'lessons_done', (select count(*) from cur where status = 'confermata' and starts + interval '1 hour' <= now() and coalesce(attendance, '') <> 'assente'),
      'cancelled', (select count(*) from cur where status = 'annullata'),
      'cancelled_prev', (select count(*) from prev where status = 'annullata'),
      'upcoming_7', (select count(*) from bk where status = 'confermata' and date between v_to and v_to + 6 and starts > now()),
      'students_total', (select count(*) from students),
      'students_new', (select count(*) from students where created_at::date between v_from and v_to),
      'students_new_prev', (select count(*) from students where created_at::date between v_pfrom and v_pto),
      'students_active', (select count(distinct student_id) from cur where status = 'confermata'),
      'students_active_prev', (select count(distinct student_id) from prev where status = 'confermata'),
      'students_app', (select count(*) from students where user_id is not null),
      'wa_consent', (select count(*) from students where wa_consent),
      'push_students', (select count(distinct student_id) from push_subs where gone_at is null and student_id is not null),
      'occupancy_slots', (select count(*) from slots),
      'occupancy_booked', (select count(*) from cur c join slots s on s.d = c.date and s.h = c.hour and s.room_id = c.room_id where c.status = 'confermata'),
      'present', (select count(*) from cur where status = 'confermata' and attendance = 'presente'),
      'absent', (select count(*) from cur where status = 'confermata' and attendance = 'assente'),
      'confirmed_by_student', (select count(*) from cur where status = 'confermata' and student_confirmed_at is not null),
      'lead_hours', (select round(avg(extract(epoch from (starts - created_at)) / 3600)::numeric, 1) from bk
                      where created_at::date between v_from and v_to and starts > created_at),
      'points_awarded', (select count(*) * v_ppl from cur where status = 'confermata' and starts + interval '1 hour' <= now() and coalesce(attendance, '') <> 'assente')
                        + coalesce((select sum(delta) from points_ledger where reason = 'rettifica' and created_at::date between v_from and v_to), 0),
      'rewards_redeemed', (select count(*) from points_ledger where reason = 'premio' and created_at::date between v_from and v_to)),
    'members', jsonb_build_object(
      'active', (select count(*) from students where member_until >= v_to),
      'expiring_30', (select count(*) from students where member_until between v_to and v_to + 30),
      'expired', (select count(*) from students where member_until < v_to),
      'none', (select count(*) from students where member_until is null),
      'medical_expiring_30', (select count(*) from students where medical_until between v_to and v_to + 30),
      'medical_expired', (select count(*) from students where medical_until < v_to),
      'expiring_list', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'member_no', member_no, 'until', member_until) order by member_until)
                                 from (select * from students where member_until between v_to and v_to + 30 order by member_until limit 10) s), '[]')),
    'weekly', (select jsonb_agg(jsonb_build_object('week', w,
        'lessons', (select count(*) from bk where status = 'confermata' and date between w and w + 6),
        'cancelled', (select count(*) from bk where status = 'annullata' and date between w and w + 6),
        'new_students', (select count(*) from students where created_at::date between w and w + 6)) order by w) from weeks),
    'heatmap', coalesce((select jsonb_agg(jsonb_build_object('dow', dow, 'hour', hour, 'n', n)) from (
        select extract(dow from date)::int as dow, hour, count(*) as n from cur where status = 'confermata' group by 1, 2) q), '[]'),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name,
        'lessons', (select count(*) from cur c where c.room_id = r.id and c.status = 'confermata'),
        'slots', (select count(*) from slots s where s.room_id = r.id),
        'booked', (select count(*) from cur c join slots s on s.d = c.date and s.h = c.hour and s.room_id = c.room_id where c.room_id = r.id and c.status = 'confermata'))
      order by r.sort, r.id) from rooms r where r.active), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'style', t.style,
        'lessons', (select count(*) from cur c where c.teacher_id = t.id and c.status = 'confermata'),
        'cancelled', (select count(*) from cur c where c.teacher_id = t.id and c.status = 'annullata'),
        'shift_hours', (select count(*) from tslots s where s.teacher_id = t.id),
        'students', (select count(distinct student_id) from cur c where c.teacher_id = t.id and c.status = 'confermata'))
      order by t.name) from teachers t where t.active), '[]'),
    'sources', coalesce((select jsonb_object_agg(source, n) from (select source, count(*) n from cur where status = 'confermata' group by source) q), '{}'),
    'cancelled_by', coalesce((select jsonb_object_agg(coalesce(cancelled_by, 'n.d.'), n) from (select cancelled_by, count(*) n from cur where status = 'annullata' group by cancelled_by) q), '{}'),
    'waitlist', jsonb_build_object(
      'total', (select count(*) from waitlist where created_at::date between v_from and v_to),
      'open', (select count(*) from waitlist where status in ('attiva', 'avvisato') and date >= v_to),
      'notified', (select count(*) from waitlist where created_at::date between v_from and v_to and notified_at is not null),
      'booked', (select count(*) from waitlist where created_at::date between v_from and v_to and status = 'prenotato'),
      'left', (select count(*) from waitlist where created_at::date between v_from and v_to and status = 'annullata')),
    'top_students', coalesce((select jsonb_agg(jsonb_build_object('name', s.name, 'member_no', s.member_no, 'lessons', q.n, 'cancelled', q.c) order by q.n desc, s.name)
       from (select student_id, count(*) filter (where status = 'confermata') n, count(*) filter (where status = 'annullata') c
               from cur group by student_id order by 2 desc limit 8) q join students s on s.id = q.student_id where q.n > 0), '[]'),
    'accounts', jsonb_build_object(
      'admin', (select count(*) from admins), 'segreteria', (select count(*) from staff),
      'insegnanti', (select count(*) from teachers where user_id is not null), 'allievi', (select count(*) from students where user_id is not null),
      'signed_in_period', (select count(*) from auth.users where last_sign_in_at::date between v_from and v_to)),
    'system', jsonb_build_object(
      'outbox_pending', (select count(*) from outbox where done_at is null),
      'outbox_errors', (select count(*) from outbox where done_at is null and attempts > 0),
      'msg_pending', (select count(*) from msg_outbox where done_at is null),
      'msg_errors', (select count(*) from msg_outbox where done_at is null and attempts > 0),
      'calendar_errors', (select count(*) from bookings where status = 'confermata' and sync_error is not null and date >= v_to),
      'push_devices', (select count(*) from push_subs where gone_at is null),
      'push_last_received', (select max(last_received_at) from push_subs),
      'last_error', (select last_error from (select last_error, created_at from outbox where last_error is not null and done_at is null
                                             union all select last_error, created_at from msg_outbox where last_error is not null and done_at is null
                                             order by created_at desc limit 1) e))
  ) into r;
  return r;
end $$;

-- ------------------------------------------------------------ permessi
revoke execute on function is_admin(), _require_admin(), sa_me(), sa_users(), sa_insights(int), _user_role(uuid) from public, anon;
grant execute on function is_admin(), sa_me(), sa_users(), sa_insights(int) to authenticated;
revoke execute on function _user_role(uuid), _require_admin() from authenticated;
revoke execute on function access_admin_state(uuid), access_user_by_phone(text), access_norm_phone(text), access_pw_changed(uuid), access_unlink_all(uuid),
  access_assign(uuid, text, text, bigint, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function access_admin_state(uuid), access_user_by_phone(text), access_norm_phone(text), access_pw_changed(uuid), access_unlink_all(uuid),
  access_assign(uuid, text, text, bigint, text, text, text, text, boolean), access_user_by_email(text) to service_role;

-- primo amministratore: utente "admin" (password iniziale "admin", da cambiare al primo accesso)
do $$ declare v uuid; begin
  if to_regclass('auth.identities') is null then return; end if;   -- ambiente di prova senza Supabase Auth completo
  select id into v from auth.users where email = 'admin@guapacha.invalid';
  if v is null then
    v := gen_random_uuid();
    insert into auth.users(instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
      phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
    values ('00000000-0000-0000-0000-000000000000', v, 'authenticated', 'authenticated', 'admin@guapacha.invalid',
      extensions.crypt('admin', extensions.gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}', '{"name":"Amministratore"}',
      now(), now(), '', '', '', '', '', '', '', '', false, false);
    insert into auth.identities(provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (v::text, v, jsonb_build_object('sub', v::text, 'email', 'admin@guapacha.invalid', 'email_verified', true), 'email', now(), now(), now());
  end if;
  insert into admins(user_id, must_change_password) values (v, true) on conflict do nothing;
end $$;
