-- =====================================================================
--  Orario esatto di inizio: la griglia resta a ore piene, ma una lezione può
--  iniziare a un minuto diverso (es. 18:30). Lo vedono app, segreteria, calendari e WhatsApp.
-- =====================================================================
alter table bookings add column if not exists start_min int not null default 0 check (start_min between 0 and 59);

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
            'guests', b.guests, 'start_min', b.start_min);
        elsif p_student is not null and b.student_id = p_student then
          v_cell := v_cell || jsonb_build_object('mine', true, 'booking_id', b.id, 'note', b.note, 'guests', b.guests, 'start_min', b.start_min);
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

create or replace function _student_bookings(p_student bigint) returns jsonb language sql stable security definer set search_path = public as $$
  with x as (
    select b.id, b.date, b.hour, b.start_min, b.note, b.status, b.room_id, b.teacher_id, b.guests, r.name as room_name,
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
  select jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'start_min', b.start_min, 'status', b.status, 'source', b.source, 'note', b.note,
    'room_id', b.room_id, 'room', r.name, 'teacher_id', b.teacher_id, 'teacher', t.name, 'teacher_style', t.style,
    'student_id', s.id, 'student_name', s.name, 'student_phone', s.phone, 'student_email', s.email, 'wa_consent', s.wa_consent,
    'guests', b.guests, 'alarm_minutes', coalesce(_setting_int('cal_alarm_minutes'), 120),
    'created_at', b.created_at, 'cancelled_by', b.cancelled_by, 'gcal_event_id', b.gcal_event_id,
    'outlook_event_id', b.outlook_event_id, 'sync_error', b.sync_error, 'cal_stale', b.cal_stale)
  from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id join students s on s.id = b.student_id
  where b.id = p_id
$$;

create or replace function admin_bookings(p_from date, p_to date, p_teacher bigint default null, p_room bigint default null,
  p_status text default null, p_q text default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_staff();
  return coalesce((select jsonb_agg(jsonb_build_object('id', b.id, 'date', b.date, 'hour', b.hour, 'start_min', b.start_min, 'status', b.status, 'source', b.source,
      'note', b.note, 'created_at', b.created_at, 'cancelled_at', b.cancelled_at, 'cancelled_by', b.cancelled_by, 'sync_error', b.sync_error,
      'room_name', r.name, 'teacher_name', t.name, 'student_name', s.name, 'student_phone', s.phone, 'student_id', s.id)
      order by b.date, b.hour, r.sort)
    from bookings b join rooms r on r.id = b.room_id join teachers t on t.id = b.teacher_id join students s on s.id = b.student_id
    where b.date between p_from and p_to
      and (p_teacher is null or b.teacher_id = p_teacher) and (p_room is null or b.room_id = p_room)
      and (nullif(p_status, '') is null or b.status = p_status)
      and (nullif(trim(p_q), '') is null or s.name ilike '%' || trim(p_q) || '%'
           or (regexp_replace(p_q, '[^0-9]', '', 'g') <> '' and s.phone like '%' || regexp_replace(p_q, '[^0-9]', '', 'g') || '%'))), '[]');
end $$;

-- la segreteria imposta i minuti di inizio (calendari e allievo vengono aggiornati)
create or replace function admin_set_start_min(p_id bigint, p_min int) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_consent boolean;
begin
  perform _require_staff();
  if p_min is null or p_min not between 0 and 59 then perform _err('Minuti non validi.'); end if;
  update bookings set start_min = p_min, cal_stale = true where id = p_id and status = 'confermata' and start_min <> p_min;
  if found then
    insert into outbox(kind, booking_id) values ('cal_sync', p_id);
    select s.wa_consent into v_consent from bookings b join students s on s.id = b.student_id where b.id = p_id;
    if v_consent then insert into outbox(kind, booking_id) values ('wa_confirm', p_id); end if;
    perform _kick_worker();
  end if;
  return _booking_json(p_id);
end $$;

revoke execute on function admin_set_start_min(bigint, int) from public, anon;
grant execute on function admin_set_start_min(bigint, int) to authenticated;
