-- =====================================================================
--  Link personale per aggiungere una lezione al calendario (file .ics servito via HTTPS):
--  funziona anche sull'iPhone e dall'app installata, dove i download dal browser sono bloccati.
-- =====================================================================
alter table bookings add column if not exists ics_token uuid not null default gen_random_uuid();

create or replace function _student_bookings(p_student bigint) returns jsonb language sql stable security definer set search_path = public as $$
  with x as (
    select b.id, b.date, b.hour, b.start_min, b.note, b.status, b.room_id, b.teacher_id, b.guests, b.ics_token, r.name as room_name,
           t.name as teacher_name, t.style as teacher_style, t.color as teacher_color,
           (b.status = 'confermata' and _slot_start(b.date, b.hour) > now()) as upcoming
    from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id
    where b.student_id = p_student)
  select jsonb_build_object(
    'upcoming', coalesce((select jsonb_agg(to_jsonb(x) - 'upcoming' order by date, hour) from x where upcoming), '[]'),
    'past', coalesce((select jsonb_agg(to_jsonb(y) - 'upcoming' - 'ics_token' order by date desc, hour desc)
                      from (select * from x where not upcoming order by date desc, hour desc limit 50) y), '[]'))
$$;

-- usata solo dalla Edge Function "ics" (service_role): serve id + token corretti
create or replace function ics_booking(p_id bigint, p_token uuid) returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'start_min', b.start_min, 'status', b.status, 'note', b.note,
    'room', r.name, 'teacher', t.name, 'teacher_style', t.style, 'guests', b.guests,
    'school', _setting('school_name'), 'lesson_label', _setting('lesson_label'), 'timezone', _tz(),
    'alarm_minutes', coalesce(_setting_int('cal_alarm_minutes'), 120))
  from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id
  where b.id = p_id and b.ics_token = p_token
$$;

revoke execute on function ics_booking(bigint, uuid) from public, anon, authenticated;
grant execute on function ics_booking(bigint, uuid) to service_role;
