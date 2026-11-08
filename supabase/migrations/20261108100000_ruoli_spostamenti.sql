-- =====================================================================
--  Insegnanti con accesso proprio, spostamento delle lezioni, gestione accessi.
--  - Gli allievi continuano a vedere solo "Occupata · insegnante", mai gli altri allievi.
--  - Insegnanti e segreteria vedono insegnante e allievo di ogni lezione.
--  - Il telefono dell'allievo lo vede solo la segreteria e l'insegnante della lezione.
-- =====================================================================

alter table teachers add column if not exists user_id uuid unique references auth.users(id) on delete set null;
-- la lezione è stata spostata: il worker ricrea gli eventi sui calendari
alter table bookings add column if not exists cal_stale boolean not null default false;

-- ------------------------------------------------------------ ruoli
create or replace function _teacher_of_user() returns bigint language sql stable security definer set search_path = public as
$$ select id from teachers where user_id = auth.uid() and active limit 1 $$;

create or replace function my_role() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare t teachers;
begin
  if auth.uid() is null then return jsonb_build_object('role', null); end if;
  if is_staff() then return jsonb_build_object('role', 'staff'); end if;
  select * into t from teachers where user_id = auth.uid() and active;
  if found then return jsonb_build_object('role', 'teacher', 'teacher_id', t.id, 'name', t.name); end if;
  return jsonb_build_object('role', null);
end $$;

create or replace function _require_teacher() returns bigint language plpgsql stable security definer set search_path = public as $$
declare v bigint := _teacher_of_user();
begin
  if v is null then perform _err('Accesso riservato agli insegnanti e alla segreteria.'); end if;
  return v;
end $$;

-- ------------------------------------------------------------ area insegnanti (sola lettura)
create or replace function teacher_base() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tid bigint := _require_teacher();
begin
  return jsonb_build_object('school', _setting('school_name'), 'today', _today(), 'teacher_id', v_tid,
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'info', info, 'active', active) order by sort, id) from rooms where active), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'style', style, 'color', color, 'active', active) order by id)
                          from teachers where active), '[]'));
end $$;

create or replace function teacher_day(p_date date) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tid bigint := _require_teacher(); g jsonb;
begin
  g := _day_grid(p_date, null, true);
  -- telefono e dettagli tecnici solo per le proprie lezioni
  g := jsonb_set(g, '{cells}', coalesce((
    select jsonb_agg(case when c->>'status' = 'booked' and (c->>'teacher_id')::bigint <> v_tid
                          then c - 'student_phone' - 'sync_error' - 'student_id'
                          else c - 'sync_error' end order by o)
      from jsonb_array_elements(g->'cells') with ordinality as x(c, o)), '[]'));
  return g || jsonb_build_object(
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'date', b.date, 'start_hour', b.start_hour, 'end_hour', b.end_hour,
                          'room_id', b.room_id, 'teacher_id', b.teacher_id, 'title', b.title, 'room_name', r.name, 'teacher_name', t.name) order by b.start_hour)
                        from blocks b left join rooms r on r.id = b.room_id left join teachers t on t.id = b.teacher_id where b.date = p_date), '[]'),
    'shifts', coalesce((select jsonb_agg(jsonb_build_object('teacher_id', teacher_id, 'start_hour', start_hour, 'end_hour', end_hour))
                        from shifts where weekday = extract(dow from p_date)::int), '[]'));
end $$;

create or replace function teacher_week(p_start date) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin perform _require_teacher(); return _week_summary(p_start); end $$;

-- ------------------------------------------------------------ spostamento lezioni (segreteria)
create or replace function admin_move_booking(p_id bigint, p_date date, p_hour int, p_room_id bigint,
  p_teacher_id bigint default null, p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  b bookings; v_room rooms; v_teacher teachers; v_tid bigint; v_blk blocks; v_con text; v_consent boolean; v_when_changed boolean;
begin
  perform _require_staff();
  select * into b from bookings where id = p_id for update;
  if not found or b.status <> 'confermata' then perform _err('Lezione non trovata o già annullata.'); end if;
  v_tid := coalesce(p_teacher_id, b.teacher_id);
  if b.date = p_date and b.hour = p_hour and b.room_id = p_room_id and b.teacher_id = v_tid then return _booking_json(p_id); end if;

  if p_date is null or p_hour is null then perform _err('Data o ora non valida.'); end if;
  if _slot_start(b.date, b.hour) <= now() then perform _err('La lezione è già iniziata o passata: non si può spostare.'); end if;
  if _slot_start(p_date, p_hour) <= now() then perform _err('Non si può spostare una lezione in un orario già passato.'); end if;
  if not (p_hour = any(_opening_hours(p_date))) then perform _err('La scuola è chiusa a quell''ora.'); end if;
  select * into v_room from rooms where id = p_room_id and active;
  if not found then perform _err('Sala non valida.'); end if;
  select * into v_teacher from teachers where id = v_tid and active;
  if not found then perform _err('Insegnante non valido.'); end if;

  select * into v_blk from blocks x where x.date = p_date and p_hour >= x.start_hour and p_hour < x.end_hour
     and (x.room_id = p_room_id or (x.room_id is null and x.teacher_id is null)) limit 1;
  if found then perform _err(format('%s non è disponibile a quell''ora (%s).', v_room.name, v_blk.title)); end if;
  if exists (select 1 from blocks x where x.date = p_date and x.teacher_id = v_tid and p_hour >= x.start_hour and p_hour < x.end_hour) then
    perform _err(format('%s non è disponibile a quell''ora.', v_teacher.name));
  end if;
  if not coalesce(p_force, false) and not exists (select 1 from shifts s where s.teacher_id = v_tid
       and s.weekday = extract(dow from p_date)::int and p_hour >= s.start_hour and p_hour < s.end_hour) then
    perform _err(format('%s non è in turno a quell''ora.', v_teacher.name));
  end if;

  v_when_changed := b.date <> p_date or b.hour <> p_hour;
  begin
    update bookings set date = p_date, hour = p_hour, room_id = p_room_id, teacher_id = v_tid, cal_stale = true,
           reminded_at = case when v_when_changed then null else reminded_at end
     where id = p_id;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_con = 'uq_room_slot' then perform _err(format('%s è già occupata a quell''ora.', v_room.name));
    elsif v_con = 'uq_teacher_slot' then perform _err(format('%s ha già una lezione a quell''ora.', v_teacher.name));
    elsif v_con = 'uq_student_slot' then perform _err('L''allievo ha già un''altra lezione a quell''ora.');
    else raise; end if;
  end;

  -- calendari aggiornati e, se l'allievo ha dato il consenso, nuovo messaggio con sala, ora e insegnante
  insert into outbox(kind, booking_id) values ('cal_sync', p_id);
  select wa_consent into v_consent from students where id = b.student_id;
  if v_consent then insert into outbox(kind, booking_id) values ('wa_confirm', p_id); end if;
  perform _kick_worker();
  return _booking_json(p_id);
end $$;

-- ------------------------------------------------------------ accessi (segreteria)
create or replace function admin_accounts() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_staff();
  return jsonb_build_object(
    'staff', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'email', u.email, 'me', s.user_id = auth.uid()) order by u.email)
                       from staff s join auth.users u on u.id = s.user_id), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('teacher_id', t.id, 'email', u.email))
                          from teachers t join auth.users u on u.id = t.user_id), '[]'));
end $$;

create or replace function admin_unlink_teacher(p_teacher_id bigint) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update teachers set user_id = null where id = p_teacher_id;
  return jsonb_build_object('ok', true);
end $$;

-- elenco insegnanti con l'email di accesso (stessa firma di prima)
create or replace function admin_teachers() returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_staff();
  return coalesce((select jsonb_agg(to_jsonb(t) - 'user_id' || jsonb_build_object(
      'login_email', (select email from auth.users u where u.id = t.user_id),
      'shifts', coalesce((select jsonb_agg(jsonb_build_object('weekday', weekday, 'start_hour', start_hour, 'end_hour', end_hour)
                          order by weekday, start_hour) from shifts where teacher_id = t.id), '[]'))
    order by t.active desc, t.id) from teachers t), '[]');
end $$;

-- usate solo dalla Edge Function "accessi" (service_role), dopo aver verificato che chi chiama è della segreteria
create or replace function access_is_staff(p_uid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from staff where user_id = p_uid) $$;

create or replace function access_user_by_email(p_email text) returns uuid language sql stable security definer set search_path = public as
$$ select id from auth.users where lower(email) = lower(trim(p_email)) limit 1 $$;

create or replace function access_link(p_user uuid, p_role text, p_teacher bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from students where user_id = p_user) then perform _err('Questa email appartiene a un allievo.'); end if;
  if p_role = 'staff' then
    insert into staff(user_id) values (p_user) on conflict do nothing;
  elsif p_role = 'teacher' then
    if not exists (select 1 from teachers where id = p_teacher) then perform _err('Insegnante non trovato.'); end if;
    update teachers set user_id = null where user_id = p_user and id <> p_teacher;
    update teachers set user_id = p_user where id = p_teacher;
  else
    perform _err('Ruolo non valido.');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------ calendari dopo uno spostamento
create or replace function _booking_json(p_id bigint) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'status', b.status, 'source', b.source, 'note', b.note,
    'room_id', b.room_id, 'room', r.name, 'teacher_id', b.teacher_id, 'teacher', t.name, 'teacher_style', t.style,
    'student_id', s.id, 'student_name', s.name, 'student_phone', s.phone, 'wa_consent', s.wa_consent,
    'created_at', b.created_at, 'cancelled_by', b.cancelled_by, 'gcal_event_id', b.gcal_event_id,
    'outlook_event_id', b.outlook_event_id, 'sync_error', b.sync_error, 'cal_stale', b.cal_stale)
  from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id join students s on s.id = b.student_id
  where b.id = p_id
$$;

create or replace function worker_set_sync(p_booking bigint, p_gcal text, p_outlook text, p_error text) returns void language sql security definer set search_path = public as $$
  update bookings set gcal_event_id = p_gcal, outlook_event_id = p_outlook, sync_error = p_error,
         cal_stale = case when p_error is null then false else cal_stale end
   where id = p_booking
$$;

-- ------------------------------------------------------------ permessi
revoke execute on function _teacher_of_user(), _require_teacher(), access_is_staff(uuid), access_user_by_email(text),
  access_link(uuid, text, bigint) from public, anon, authenticated;
grant execute on function my_role() to anon, authenticated;
grant execute on function teacher_base(), teacher_day(date), teacher_week(date),
  admin_move_booking(bigint, date, int, bigint, bigint, boolean), admin_accounts(), admin_unlink_teacher(bigint), admin_teachers()
  to authenticated;
grant execute on function access_is_staff(uuid), access_user_by_email(text), access_link(uuid, text, bigint),
  _teacher_of_user(), _require_teacher() to service_role;

-- =====================================================================
--  Partecipanti e inviti nel calendario
--  - l'allievo può indicare la sua email: riceve l'invito (Outlook della scuola) e può
--    scaricare la lezione nel proprio calendario con l'avviso (cal_alarm_minutes) prima;
--  - a una lezione si possono aggiungere partecipanti (es. lezione di coppia) con nome ed email.
-- =====================================================================
alter table students add column if not exists email text not null default '';
alter table bookings add column if not exists guests jsonb not null default '[]';
insert into settings(key, value) values ('cal_alarm_minutes', '120') on conflict (key) do nothing;

create or replace function _clean_email(p text) returns text language plpgsql immutable set search_path = public as $$
declare e text := lower(trim(coalesce(p, '')));
begin
  if e = '' then return ''; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$' then perform _err(format('Email non valida: %s', e)); end if;
  return left(e, 120);
end $$;

-- [{name, email}] ripulito: massimo 3 partecipanti, nome obbligatorio
create or replace function _clean_guests(p jsonb) returns jsonb language plpgsql immutable set search_path = public as $$
declare g jsonb; v jsonb := '[]'; n text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return '[]'; end if;
  if jsonb_array_length(p) > 3 then perform _err('Al massimo 3 partecipanti per lezione.'); end if;
  for g in select * from jsonb_array_elements(p) loop
    n := left(trim(coalesce(g->>'name', '')), 80);
    if n = '' and coalesce(trim(g->>'email'), '') = '' then continue; end if;
    if length(n) < 2 then perform _err('Scrivi il nome di ogni partecipante.'); end if;
    v := v || jsonb_build_array(jsonb_build_object('name', n, 'email', _clean_email(g->>'email')));
  end loop;
  return v;
end $$;

create or replace function _set_guests(p_id bigint, p_guests jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare v jsonb := _clean_guests(p_guests);
begin
  update bookings set guests = v, cal_stale = true where id = p_id and status = 'confermata';
  if not found then perform _err('Lezione non trovata o annullata.'); end if;
  insert into outbox(kind, booking_id) values ('cal_sync', p_id);
  perform _kick_worker();
  return v;
end $$;

create or replace function set_booking_guests(p_id bigint, p_guests jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
declare s students := _current_student();
begin
  if not exists (select 1 from bookings where id = p_id and student_id = s.id and status = 'confermata' and _slot_start(date, hour) > now()) then
    perform _err('Lezione non trovata.');
  end if;
  return _set_guests(p_id, p_guests);
end $$;

create or replace function admin_set_booking_guests(p_id bigint, p_guests jsonb) returns jsonb language plpgsql security definer set search_path = public as $$
begin perform _require_staff(); return _set_guests(p_id, p_guests); end $$;

create or replace function me_save_email(p_email text) returns jsonb language plpgsql security definer set search_path = public as $$
declare s students := _current_student();
begin
  update students set email = _clean_email(p_email) where id = s.id;
  return jsonb_build_object('email', (select email from students where id = s.id));
end $$;

create or replace function admin_set_student_email(p_id bigint, p_email text) returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform _require_staff();
  update students set email = _clean_email(p_email) where id = p_id;
  if not found then perform _err('Allievo non trovato.'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- profilo con email e durata dell'avviso del calendario
create or replace function public_config() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s students;
begin
  if auth.uid() is not null then select * into s from students where user_id = auth.uid(); end if;
  return jsonb_build_object(
    'school', _setting('school_name'), 'school_phone', _setting('school_phone'), 'lesson_label', _setting('lesson_label'),
    'horizon_days', _setting_int('horizon_days'), 'cancel_hours', _setting_int('cancel_hours'),
    'today', _today(), 'bookable_until', _bookable_until(), 'timezone', _tz(),
    'cal_alarm_minutes', coalesce(_setting_int('cal_alarm_minutes'), 120),
    'whatsapp_number', _setting('whatsapp_number'), 'whatsapp_bot', _setting('bot_enabled') = 'true',
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'info', info) order by sort, id) from rooms where active), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'style', t.style, 'color', t.color,
        'shifts', coalesce((select jsonb_agg(jsonb_build_object('weekday', weekday, 'start_hour', start_hour, 'end_hour', end_hour) order by weekday, start_hour)
                            from shifts where teacher_id = t.id), '[]')) order by t.id) from teachers t where t.active), '[]'),
    'me', case when s.id is null then null else jsonb_build_object('name', s.name, 'phone', '+' || s.phone, 'wa_consent', s.wa_consent, 'email', s.email) end);
end $$;

create or replace function _student_bookings(p_student bigint) returns jsonb language sql stable security definer set search_path = public as $$
  with x as (
    select b.id, b.date, b.hour, b.note, b.status, b.room_id, b.teacher_id, b.guests, r.name as room_name,
           t.name as teacher_name, t.style as teacher_style, t.color as teacher_color,
           (b.status = 'confermata' and _slot_start(b.date, b.hour) > now()) as upcoming
    from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id
    where b.student_id = p_student)
  select jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(to_jsonb(x) - 'upcoming' order by date, hour) from x where upcoming), '[]'),
    'past', coalesce((select jsonb_agg(to_jsonb(y) - 'upcoming' order by date desc, hour desc)
                      from (select * from x where not upcoming order by date desc, hour desc limit 50) y), '[]'))
$$;

create or replace function _booking_json(p_id bigint) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'status', b.status, 'source', b.source, 'note', b.note,
    'room_id', b.room_id, 'room', r.name, 'teacher_id', b.teacher_id, 'teacher', t.name, 'teacher_style', t.style,
    'student_id', s.id, 'student_name', s.name, 'student_phone', s.phone, 'student_email', s.email, 'wa_consent', s.wa_consent,
    'guests', b.guests, 'alarm_minutes', coalesce(_setting_int('cal_alarm_minutes'), 120),
    'created_at', b.created_at, 'cancelled_by', b.cancelled_by, 'gcal_event_id', b.gcal_event_id,
    'outlook_event_id', b.outlook_event_id, 'sync_error', b.sync_error, 'cal_stale', b.cal_stale)
  from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id join students s on s.id = b.student_id
  where b.id = p_id
$$;

-- griglia: ora mostra anche i partecipanti (segreteria, insegnanti e l'allievo stesso)
create or replace function _day_grid(p_date date, p_student bigint default null, p_admin boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_hours int[] := _opening_hours(p_date);
  v_wd int := extract(dow from p_date)::int;
  v_beyond boolean := not p_admin and p_date > _bookable_until();
  v_cells jsonb := '[]';
  h int; r record; b record; blk record; v_avail bigint[]; v_cell jsonb;
begin
  foreach h in array v_hours loop
    select coalesce(array_agg(t.id order by t.id), '{}') into v_avail from teachers t
     where t.active
       and exists (select 1 from shifts s where s.teacher_id = t.id and s.weekday = v_wd and h >= s.start_hour and h < s.end_hour)
       and not exists (select 1 from bookings x where x.date = p_date and x.hour = h and x.teacher_id = t.id and x.status = 'confermata')
       and not exists (select 1 from blocks x where x.date = p_date and x.teacher_id = t.id and h >= x.start_hour and h < x.end_hour);
    for r in select id from rooms where active order by sort, id loop
      v_cell := jsonb_build_object('hour', h, 'room_id', r.id);
      select x.*, s.name as student_name, s.phone as student_phone into b
        from bookings x join students s on s.id = x.student_id
       where x.date = p_date and x.hour = h and x.room_id = r.id and x.status = 'confermata';
      if found then
        v_cell := v_cell || jsonb_build_object('status', 'booked', 'teacher_id', b.teacher_id);
        if p_admin then
          v_cell := v_cell || jsonb_build_object('booking_id', b.id, 'student_id', b.student_id, 'student_name', b.student_name,
            'student_phone', b.student_phone, 'note', b.note, 'source', b.source, 'sync_error', b.sync_error, 'created_at', b.created_at,
            'guests', b.guests);
        elsif p_student is not null and b.student_id = p_student then
          v_cell := v_cell || jsonb_build_object('mine', true, 'booking_id', b.id, 'note', b.note, 'guests', b.guests);
        end if;
      else
        select * into blk from blocks x where x.date = p_date and h >= x.start_hour and h < x.end_hour
           and (x.room_id = r.id or (x.room_id is null and x.teacher_id is null)) order by x.id limit 1;
        if found then
          v_cell := v_cell || jsonb_build_object('status', 'blocked', 'title', blk.title);
          if p_admin then v_cell := v_cell || jsonb_build_object('block_id', blk.id); end if;
        elsif _slot_start(p_date, h) <= now() then
          v_cell := v_cell || jsonb_build_object('status', 'past');
        elsif cardinality(v_avail) = 0 or v_beyond then
          v_cell := v_cell || jsonb_build_object('status', 'off');
        else
          v_cell := v_cell || jsonb_build_object('status', 'free', 'teachers', to_jsonb(v_avail));
        end if;
      end if;
      v_cells := v_cells || jsonb_build_array(v_cell);
    end loop;
  end loop;
  return jsonb_build_object(
    'date', p_date, 'label', _fmt_date(p_date), 'hours', to_jsonb(v_hours), 'cells', v_cells, 'bookable_until', _bookable_until(),
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'info', info) order by sort, id) from rooms where active), '[]'),
    'teachers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'style', style, 'color', color) order by id) from teachers where active), '[]'));
end $$;

-- elenco allievi con email (stessa firma)
create or replace function admin_students(p_q text default '') returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q text := coalesce(trim(p_q), ''); qd text := regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g');
begin
  perform _require_staff();
  return coalesce((select jsonb_agg(x order by lower(x->>'name')) from (
    select to_jsonb(s) - 'user_id' || jsonb_build_object('has_app', s.user_id is not null,
      'lessons', (select count(*) from bookings b where b.student_id = s.id and b.status = 'confermata'),
      'last_date', (select max(date) from bookings b where b.student_id = s.id and b.status = 'confermata')) as x
    from students s
    where q = '' or s.name ilike '%' || q || '%' or s.email ilike '%' || q || '%' or (qd <> '' and s.phone like '%' || qd || '%')
    order by lower(s.name) limit 200) y), '[]');
end $$;

revoke execute on function _clean_email(text), _clean_guests(jsonb), _set_guests(bigint, jsonb) from public, anon, authenticated;
grant execute on function set_booking_guests(bigint, jsonb), admin_set_booking_guests(bigint, jsonb), me_save_email(text),
  admin_set_student_email(bigint, text) to authenticated;
grant execute on function _clean_email(text), _clean_guests(jsonb), _set_guests(bigint, jsonb) to service_role;

-- impostazioni: anche i minuti dell'avviso nel calendario
create or replace function admin_save_settings(p_settings jsonb default '{}', p_opening jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; v text; o jsonb;
  allowed text[] := array['school_name','school_phone','public_url','lesson_label','horizon_days','cancel_hours',
                          'max_active_per_student','reminder_hours','whatsapp_number','timezone','cal_alarm_minutes'];
  numeric_keys text[] := array['horizon_days','cancel_hours','max_active_per_student','reminder_hours','cal_alarm_minutes'];
begin
  perform _require_staff();
  for k, v in select key, value #>> '{}' from jsonb_each(coalesce(p_settings, '{}')) loop
    if not k = any(allowed) then continue; end if;
    v := trim(coalesce(v, ''));
    if k = any(numeric_keys) and v !~ '^[0-9]{1,4}$' then perform _err('Le impostazioni numeriche devono essere numeri interi.'); end if;
    if k = 'timezone' and not exists (select 1 from pg_timezone_names where name = v) then perform _err('Fuso orario non valido.'); end if;
    insert into settings(key, value) values (k, v) on conflict (key) do update set value = excluded.value;
  end loop;
  if p_opening is not null then
    for o in select * from jsonb_array_elements(p_opening) loop
      if (o->>'weekday')::int not between 0 and 6 then continue; end if;
      if o->>'start_hour' is null or o->>'end_hour' is null then
        insert into opening values ((o->>'weekday')::int, null, null) on conflict (weekday) do update set start_hour = null, end_hour = null;
      elsif (o->>'start_hour')::int >= 0 and (o->>'end_hour')::int <= 24 and (o->>'end_hour')::int > (o->>'start_hour')::int then
        insert into opening values ((o->>'weekday')::int, (o->>'start_hour')::int, (o->>'end_hour')::int)
          on conflict (weekday) do update set start_hour = excluded.start_hour, end_hour = excluded.end_hour;
      else perform _err('Orario di apertura non valido.'); end if;
    end loop;
  end if;
  return admin_settings();
end $$;


-- su Supabase le funzioni nuove ricevono i permessi predefiniti: nessuna di queste è per utenti anonimi
revoke execute on function admin_accounts(), admin_move_booking(bigint, date, int, bigint, bigint, boolean), admin_set_booking_guests(bigint, jsonb),
  admin_set_student_email(bigint, text), admin_unlink_teacher(bigint), me_save_email(text), set_booking_guests(bigint, jsonb),
  teacher_base(), teacher_day(date), teacher_week(date) from anon, public;
