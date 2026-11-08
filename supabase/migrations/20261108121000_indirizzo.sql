-- =====================================================================
--  Indirizzo della scuola: nei calendari (luogo con mappa), nell'app e in segreteria.
-- =====================================================================
insert into settings(key, value) values ('school_address', '') on conflict (key) do nothing;

create or replace function public_config() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s students;
begin
  if auth.uid() is not null then select * into s from students where user_id = auth.uid(); end if;
  return jsonb_build_object(
    'school', _setting('school_name'), 'school_phone', _setting('school_phone'), 'school_address', _setting('school_address'), 'lesson_label', _setting('lesson_label'),
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

create or replace function admin_save_settings(p_settings jsonb default '{}', p_opening jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k text; v text; o jsonb;
  allowed text[] := array['school_name','school_phone','public_url','lesson_label','horizon_days','cancel_hours',
                          'max_active_per_student','reminder_hours','whatsapp_number','timezone','cal_alarm_minutes','school_address'];
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

create or replace function _booking_json(p_id bigint) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'start_min', b.start_min, 'status', b.status, 'source', b.source, 'note', b.note,
    'room_id', b.room_id, 'room', r.name, 'teacher_id', b.teacher_id, 'teacher', t.name, 'teacher_style', t.style,
    'student_id', s.id, 'student_name', s.name, 'student_phone', s.phone, 'student_email', s.email, 'wa_consent', s.wa_consent,
    'guests', b.guests, 'school_address', _setting('school_address'), 'alarm_minutes', coalesce(_setting_int('cal_alarm_minutes'), 120),
    'created_at', b.created_at, 'cancelled_by', b.cancelled_by, 'gcal_event_id', b.gcal_event_id,
    'outlook_event_id', b.outlook_event_id, 'sync_error', b.sync_error, 'cal_stale', b.cal_stale)
  from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id join students s on s.id = b.student_id
  where b.id = p_id
$$;

create or replace function ics_booking(p_id bigint, p_token uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'start_min', b.start_min, 'status', b.status, 'note', b.note,
    'room', r.name, 'teacher', t.name, 'teacher_style', t.style, 'guests', b.guests,
    'school', _setting('school_name'), 'address', _setting('school_address'), 'lesson_label', _setting('lesson_label'), 'timezone', _tz(),
    'alarm_minutes', coalesce(_setting_int('cal_alarm_minutes'), 120))
  from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id
  where b.id = p_id and b.ics_token = p_token
$$;
