// Pannello segreteria: agenda, prenotazioni, allievi, chiusure e impostazioni.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (typeof props === 'string') e.className = props;
    else if (props) for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e[k] = v; else if (k === 'text') e.textContent = v;
      else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const DOW = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  const DOWL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const MON = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const monday = (k) => addDays(k, -((parse(k).getDay() + 6) % 7));
  const fmtDay = (k) => { const d = parse(k); return `${DOWL[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtShort = (k) => { const d = parse(k); return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const phone = (p) => (p ? '+' + String(p).replace(/^\+/, '') : '');
  const SRC = { app: 'App', segreteria: 'Segreteria', whatsapp: 'WhatsApp' };
  /** indirizzo dell'app allievi: la cartella sopra /segreteria/ */
  const appRoot = () => new URL('../', location.href).href;

  const S = { role: null, teacherId: null, status: null, rooms: [], teachers: [], view: 'agenda', date: null, mode: 'sale', day: null, week: [], list: { q: '' }, students: { q: '' } };
  const staff = () => S.role === 'staff';

  // ---------------- Supabase ----------------
  const C = window.SCUOLA_CONFIG || {};
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'segreteria-sessione' },
  });
  /** Funzione del database; i messaggi delle regole (P0001) sono già in italiano. */
  async function rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      if (error.code === 'PGRST301' || /JWT/.test(error.message || '')) { showLogin(); throw new Error('Sessione scaduta: accedi di nuovo.'); }
      if (error.code === 'P0001' && /^Accesso riservato/.test(error.message)) { showLogin('Questo account non è abilitato: chiedi alla segreteria.'); }
      throw new Error(error.code === 'P0001' ? error.message : 'Operazione non riuscita. Controlla la connessione e riprova.');
    }
    return data;
  }
  /** { date, hour } → { p_date, p_hour } per le funzioni del database */
  const P = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => ['p_' + k, v]));
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3800); }

  const dlg = $('dlg'), sheet = $('sheet');
  function openSheet(...nodes) { sheet.replaceChildren(...nodes.filter((n) => n != null && n !== false)); if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } } }
  function closeSheet() { try { dlg.close(); } catch { dlg.removeAttribute('open'); } }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });

  function confirmBtn(label, sureLabel, action, cls = 'btn danger') {
    const b = el('button', { class: cls, type: 'button', text: label }); let armed = false, t;
    b.onclick = async () => {
      if (!armed) { armed = true; b.textContent = sureLabel; b.classList.add('sure'); t = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('sure'); }, 4000); return; }
      clearTimeout(t); b.disabled = true;
      try { await action(); } catch (e) { toast(e.message); b.disabled = false; armed = false; b.textContent = label; b.classList.remove('sure'); }
    };
    return b;
  }
  const field = (label, input) => el('div', 'field', el('label', { for: input.id }, label), input);
  const hourSelect = (id, val, from = 6, to = 24) => { const s = el('select', { id }); for (let h = from; h <= to; h++) s.append(el('option', { value: h, selected: h === val }, `${pad(h)}:00`)); return s; };

  // ================= accesso =================
  function showLogin(msg = '') {
    $('app').hidden = true; $('login').hidden = false; closeSheet(); $('lg-err').textContent = msg; $('lg-user').focus();
    if (msg) sb.auth.signOut().catch(() => {});
  }
  $('login-form').onsubmit = async (e) => {
    e.preventDefault(); $('lg-err').textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: $('lg-user').value.trim(), password: $('lg-pass').value });
    if (error) { $('lg-err').textContent = error.status === 400 ? 'Email o password errate.' : 'Accesso non riuscito. Riprova.'; return; }
    $('lg-pass').value = '';
    try { await boot(); } catch (x) { $('lg-err').textContent = x.message; }
  };
  $('logout').onclick = $('logout2').onclick = async () => { await sb.auth.signOut().catch(() => {}); showLogin(); };

  async function loadBase() {
    if (!staff()) {
      const b = await rpc('teacher_base');
      S.status = { school: b.school, today: b.today }; S.rooms = b.rooms; S.teachers = b.teachers;
      $('brand').firstChild.textContent = b.school; $('brand').lastChild.textContent = `Insegnante · ${teacherById(b.teacher_id)?.name || ''}`;
      document.title = `Agenda · ${b.school}`;
      $('integr').replaceChildren();
      return;
    }
    [S.status, S.rooms, S.teachers] = await Promise.all([rpc('admin_status'), rpc('admin_rooms'), rpc('admin_teachers')]);
    $('brand').firstChild.textContent = S.status.school;
    document.title = `Segreteria · ${S.status.school}`;
    const i = S.status.integrations;
    $('integr').replaceChildren(
      el('div', null, `Google Calendar: ${i.google ? 'attivo' : 'non attivo'}`), el('div', null, `Outlook: ${i.outlook ? 'attivo' : 'non attivo'}`),
      el('div', null, `WhatsApp: ${i.whatsapp ? (i.bot ? 'notifiche e bot' : 'notifiche') : 'non attivo'}`),
    );
  }
  const activeRooms = () => S.rooms.filter((r) => r.active);
  const activeTeachers = () => S.teachers.filter((t) => t.active);
  const teacherById = (id) => S.teachers.find((t) => t.id === id);
  const roomById = (id) => S.rooms.find((r) => r.id === id);

  async function boot() {
    const { data } = await sb.auth.getSession();
    if (!data.session) { showLogin(); return; }
    let me;
    try { me = await rpc('my_role'); } catch (e) { showLogin(e.message); return; }
    if (!me.role) { showLogin('Questo account non è abilitato: chiedi alla segreteria.'); return; }
    S.role = me.role; S.teacherId = me.teacher_id || null;
    document.body.classList.toggle('teacher', !staff());
    try { await loadBase(); } catch (e) { showLogin(e.message); return; }
    $('login').hidden = true; $('app').hidden = false;
    S.date ||= S.status.today;
    const [v, qs] = location.hash.slice(1).split('?');
    const q = new URLSearchParams(qs || '').get('q');
    if (q) S.students.q = q;   // dal QR della tessera: #allievi?q=GS-0001
    go(staff() && VIEWS.includes(v) ? v : 'agenda');
  }

  const VIEWS = ['agenda', 'occupazione', 'attesa', 'prenotazioni', 'allievi', 'blocchi', 'impostazioni'];
  function go(view) {
    if (!staff()) view = 'agenda';
    S.view = view; if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
    document.querySelectorAll('.nav').forEach((b) => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    ({ agenda: viewAgenda, occupazione: viewOccupancy, attesa: viewWaitlist, prenotazioni: viewList, allievi: viewStudents, blocchi: viewBlocks, impostazioni: viewSettings })[view]();
  }
  document.querySelectorAll('.nav').forEach((b) => (b.onclick = () => go(b.dataset.view)));

  // ================= AGENDA =================
  async function viewAgenda() {
    const main = $('main');
    const dateIn = el('input', { type: 'date', id: 'ag-date', value: S.date });
    dateIn.onchange = () => { if (dateIn.value) { S.date = dateIn.value; viewAgenda(); } };
    const seg = el('div', 'seg',
      el('button', { type: 'button', 'aria-pressed': String(S.mode === 'sale'), onclick: () => { S.mode = 'sale'; viewAgenda(); } }, 'Per sala'),
      el('button', { type: 'button', 'aria-pressed': String(S.mode === 'insegnanti'), onclick: () => { S.mode = 'insegnanti'; viewAgenda(); } }, 'Per insegnante'));
    main.replaceChildren(
      el('div', 'toolbar',
        el('h1', { class: 'grow' }, cap(fmtDay(S.date))),
        el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Giorno precedente', onclick: () => { S.date = addDays(S.date, -1); viewAgenda(); } }, '‹'),
        el('button', { class: 'btn', type: 'button', onclick: () => { S.date = S.status.today; viewAgenda(); } }, 'Oggi'),
        el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Giorno successivo', onclick: () => { S.date = addDays(S.date, 1); viewAgenda(); } }, '›'),
        dateIn, seg,
        staff() ? el('button', { class: 'btn', type: 'button', onclick: () => blockForm({ date: S.date }) }, 'Blocca orario') : null),
      el('div', { id: 'ag-week', class: 'days' }), el('div', { id: 'ag-stats', class: 'stats' }),
      el('div', { id: 'ag-board', class: 'scroll' }, el('div', 'closedday', 'Caricamento…')),
      staff() ? el('div', 'legend',
        el('span', null, el('b', null, 'Trascina'), ' una lezione su un\'altra casella per spostarla (sul telefono: tieni premuto)'),
        el('span', null, el('i', { class: 'dot', style: '--tc:var(--ok)' }), 'Libera: clic per prenotare a nome di un allievo'),
        el('span', null, el('i', { class: 'dot', style: '--tc:var(--muted)' }), '— nessun insegnante in turno (clic per forzare)'),
        el('span', null, 'Clic sul nome di una sala o di un insegnante per rinominarlo'))
      : el('div', 'legend', el('span', null, 'Le tue lezioni hanno il bordo spesso. Per modifiche contatta la segreteria.')));
    try {
      const ws = monday(S.date);
      const [day, week] = await Promise.all([rpc(staff() ? 'admin_day' : 'teacher_day', { p_date: S.date }), rpc(staff() ? 'admin_week' : 'teacher_week', { p_start: ws })]);
      S.day = day; S.week = week;
      renderWeekStrip(); renderStats(); renderBoard();
    } catch (e) { $('ag-board').replaceChildren(el('div', 'closedday', e.message)); }
  }

  function renderWeekStrip() {
    $('ag-week').replaceChildren(...S.week.map((d) => {
      const dt = parse(d.date);
      const b = el('button', { class: 'day' + (d.date === S.status.today ? ' today' : ''), type: 'button', 'aria-pressed': String(d.date === S.date) },
        el('span', 'dw', DOW[dt.getDay()]), el('span', 'dn', dt.getDate()), el('span', 'df', d.open ? `${d.booked} lez.` : 'chiuso'));
      b.onclick = () => { S.date = d.date; viewAgenda(); };
      return b;
    }));
  }
  function renderStats() {
    const g = S.day;
    const booked = g.cells.filter((c) => c.status === 'booked');
    const free = g.cells.filter((c) => c.status === 'free').length;
    const errs = booked.filter((c) => c.sync_error).length;
    const st = (n, l) => el('div', 'stat', el('b', null, n), el('span', null, l));
    $('ag-stats').replaceChildren(...[st(booked.length, 'lezioni prenotate'), st(free, 'sale libere (ore)'), st(new Set(booked.map((c) => c.student_id)).size, 'allievi'),
      errs ? el('div', 'stat', el('b', { style: 'color:var(--danger)' }, errs), el('span', null, 'non sincronizzate')) : null].filter(Boolean));
  }

  function renderBoard() {
    const g = S.day, board = $('ag-board');
    if (!g.hours.length) { board.replaceChildren(el('div', 'closedday', 'Scuola chiusa in questo giorno (vedi Impostazioni → Orari di apertura).')); return; }
    const cols = S.mode === 'sale' ? g.rooms : g.teachers;
    const grid = el('div', 'agenda'); grid.style.setProperty('--cols', cols.length);
    grid.append(el('div'));
    for (const c of cols) {
      const inner = S.mode === 'sale' ? [el('b', null, c.name), el('span', null, c.info)]
        : [el('b', null, el('i', { class: 'dot', style: `--tc:${c.color}` }), c.name), el('span', null, c.style)];
      grid.append(staff()
        ? el('button', { class: 'colh edit', type: 'button', title: 'Rinomina', onclick: () => (S.mode === 'sale' ? renameRoom(c.id) : renameTeacher(c.id)) }, ...inner)
        : el('div', 'colh', ...inner));
    }
    for (const h of g.hours) {
      grid.append(el('div', 'time', `${pad(h)}:00`));
      for (const col of cols) grid.append(S.mode === 'sale' ? roomSlot(g, h, col) : teacherSlot(g, h, col));
    }
    board.replaceChildren(grid);
    if (staff()) enableDrag(grid);
  }

  const hm = (b, plus = 0) => `${pad(b.hour + plus)}:${pad(b.start_min || 0)}`;
  const who = (c) => [c.student_name || 'Allievo', ...(c.guests || []).map((g) => g.name)].join(' + ');
  /** la lezione non è ancora iniziata: si può spostare */
  const future = (date, hour) => { const [y, m, d] = date.split('-').map(Number); return new Date(y, m - 1, d, hour) > new Date(); };
  function bookedSlot(c) {
    const t = teacherById(c.teacher_id), r = roomById(c.room_id);
    const own = !staff() && c.teacher_id === S.teacherId;
    const s = el('button', { class: 'slot booked' + (own ? ' own' : ''), type: 'button', style: `--tc:${t?.color || 'var(--muted)'}` },
      el('span', 'a', who(c)),
      el('span', 'b', [S.mode === 'sale' ? t?.name : r?.name, c.start_min ? `inizio ${hm(c)}` : '', c.note].filter(Boolean).join(' · ')));
    if (c.sync_error) s.append(el('span', { class: 'flag bad', title: c.sync_error }, '! cal'));
    else if (c.source !== 'app') s.append(el('span', 'flag', c.source === 'whatsapp' ? 'WA' : 'segr.'));
    s.append(confDots(c));
    s.onclick = () => { if (s.dataset.dragged) { delete s.dataset.dragged; return; } bookingDetails(c); };
    if (staff() && future(S.day.date, c.hour)) { s.dataset.bid = c.booking_id; s.classList.add('draggable'); }
    return s;
  }
  /** tre pallini: sala, insegnante, allievo (verde = confermato) */
  function confDots(c) {
    const d = (on, label) => el('i', { class: on ? 'on' : '', title: `${label}: ${on ? 'confermato' : 'da confermare'}` });
    return el('span', 'conf', d(c.room_confirmed, 'Sala'), d(c.teacher_confirmed, 'Insegnante'), d(c.student_confirmed, 'Allievo'),
      c.attendance === 'assente' ? el('b', { class: 'abs', title: 'Assente' }, 'A') : null);
  }
  /** caselle su cui si può lasciare una lezione: libere o senza insegnante, non passate né bloccate */
  const dropAttrs = (h, extra) => (staff() ? { 'data-drop': '1', 'data-hour': h, ...extra } : {});
  function roomSlot(g, h, room) {
    const c = g.cells.find((x) => x.hour === h && x.room_id === room.id);
    if (c.status === 'booked') return bookedSlot(c);
    if (c.status === 'blocked') {
      const b = g.blocks.find((x) => x.id === c.block_id);
      return el(staff() ? 'button' : 'div', { class: 'slot blocked', type: staff() ? 'button' : null, onclick: staff() ? () => blockDetails(b) : null }, el('span', 'a', c.title), el('span', 'b', b?.teacher_name || ''));
    }
    if (c.status === 'past') return el('div', 'slot off', el('span', 'a', 'Passata'));
    if (c.status === 'free') {
      const names = c.teachers.map((id) => teacherById(id)?.name).filter(Boolean);
      if (!staff()) return el('div', 'slot free ro', el('span', 'a', 'Libera'), el('span', 'b', names.join(', ')));
      return el('button', { class: 'slot free', type: 'button', ...dropAttrs(h, { 'data-room': room.id }), onclick: () => bookingForm({ date: g.date, hour: h, room_id: room.id }) },
        el('span', 'a', 'Libera'), el('span', 'b', names.join(', ')));
    }
    if (!staff()) return el('div', 'slot off', el('span', 'a', '—'));
    return el('button', { class: 'slot off clickable', type: 'button', title: 'Nessun insegnante in turno', ...dropAttrs(h, { 'data-room': room.id }), onclick: () => bookingForm({ date: g.date, hour: h, room_id: room.id }) }, el('span', 'a', '—'));
  }
  function teacherSlot(g, h, t) {
    const c = g.cells.find((x) => x.hour === h && x.status === 'booked' && x.teacher_id === t.id);
    if (c) return bookedSlot(c);
    const blk = g.blocks.find((b) => b.teacher_id === t.id && h >= b.start_hour && h < b.end_hour);
    if (blk) return el(staff() ? 'button' : 'div', { class: 'slot blocked', type: staff() ? 'button' : null, onclick: staff() ? () => blockDetails(blk) : null }, el('span', 'a', blk.title), el('span', 'b', blk.room_name || ''));
    const inShift = g.shifts.some((s) => s.teacher_id === t.id && h >= s.start_hour && h < s.end_hour);
    const anyCell = g.cells.find((x) => x.hour === h);
    if (anyCell && anyCell.status === 'past') return el('div', 'slot off', el('span', 'a', inShift ? 'Passata' : '—'));
    const freeRooms = g.cells.filter((x) => x.hour === h && (x.status === 'free' || x.status === 'off')).length;
    if (inShift && !staff()) return el('div', 'slot free ro', el('span', 'a', 'In turno · libero'), el('span', 'b', `${freeRooms} sale libere`));
    if (inShift) return el('button', { class: 'slot free', type: 'button', ...dropAttrs(h, { 'data-teacher': t.id }), onclick: () => bookingForm({ date: g.date, hour: h, teacher_id: t.id }) },
      el('span', 'a', 'In turno · libero'), el('span', 'b', `${freeRooms} sale libere`));
    return el('div', { class: 'slot off', ...dropAttrs(h, { 'data-teacher': t.id }) }, el('span', 'a', '—'));
  }

  // ---------- dettaglio e nuova prenotazione ----------
  function bookingDetails(c) {
    const t = teacherById(c.teacher_id), r = roomById(c.room_id);
    const guests = c.guests || [];
    const kv = el('dl', 'kv',
      el('dt', null, 'Allievo'), el('dd', null, c.student_name || '—'),
      c.student_phone ? el('dt', null, 'Telefono') : null, c.student_phone ? el('dd', null, el('a', { href: `tel:${phone(c.student_phone)}` }, phone(c.student_phone))) : null,
      guests.length ? el('dt', null, 'Partecipanti') : null, guests.length ? el('dd', null, guests.map((g) => g.email ? `${g.name} (${g.email})` : g.name).join(', ')) : null,
      el('dt', null, 'Insegnante'), el('dd', null, `${t?.name || ''} · ${t?.style || ''}`),
      el('dt', null, 'Sala'), el('dd', null, r?.name || ''),
      c.note ? el('dt', null, 'Nota') : null, c.note ? el('dd', null, c.note) : null,
      staff() ? el('dt', null, 'Prenotata da') : null,
      staff() ? el('dd', null, `${SRC[c.source] || c.source} · ${new Date(c.created_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`) : null,
      c.sync_error ? el('dt', null, 'Calendario') : null, c.sync_error ? el('dd', { style: 'color:var(--danger)' }, c.sync_error) : null);
    const head = el('div', null, el('h3', null, `${r?.name || ''} · ${hm(c)}`), el('div', 'meta', cap(fmtDay(S.day.date))));
    const isFuture = future(S.day.date, c.hour);
    if (!staff()) {
      const mine = c.teacher_id === S.teacherId;
      const tc = mine && isFuture ? el('button', { class: c.teacher_confirmed ? 'btn' : 'btn primary', type: 'button', onclick: async () => {
        try { await rpc('teacher_confirm', { p_id: c.booking_id, p_value: !c.teacher_confirmed }); closeSheet(); toast(c.teacher_confirmed ? 'Conferma tolta' : 'Lezione confermata'); viewAgenda(); } catch (e) { toast(e.message); }
      } }, c.teacher_confirmed ? 'Togli la mia conferma' : 'Confermo la lezione') : null;
      openSheet(head, kv, confLine(c), el('div', 'row', tc, el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'))); return;
    }
    const toggles = el('div', 'conf-toggles', ...[['sala', 'room_confirmed', 'Sala pronta'], ['insegnante', 'teacher_confirmed', 'Insegnante'], ['allievo', 'student_confirmed', 'Allievo']].map(([k, f, label]) =>
      el('button', { class: 'tog' + (c[f] ? ' on' : ''), type: 'button', 'aria-pressed': String(!!c[f]), onclick: async () => {
        try { await rpc('admin_confirm', { p_id: c.booking_id, p_what: k, p_value: !c[f] }); c[f] = !c[f]; bookingDetails(c); viewAgenda(); } catch (e) { toast(e.message); }
      } }, (c[f] ? '✓ ' : '') + label)));
    const att = !isFuture ? el('div', 'conf-toggles', el('span', 'label', 'Presenza'), ...[['presente', 'Presente'], ['assente', 'Assente']].map(([v, label]) =>
      el('button', { class: 'tog' + (c.attendance === v ? ' on' : ''), type: 'button', onclick: async () => {
        try { await rpc('admin_set_attendance', { p_id: c.booking_id, p_value: c.attendance === v ? null : v }); c.attendance = c.attendance === v ? null : v; bookingDetails(c); viewAgenda(); } catch (e) { toast(e.message); }
      } }, label)), el('span', 'muted small', 'Gli assenti non ricevono punti.')) : null;
    const row = el('div', 'row');
    if (c.sync_error) row.append(el('button', { class: 'btn', type: 'button', onclick: async () => { await rpc('admin_resync', { p_id: c.booking_id }); toast('Nuovo tentativo avviato: controlla tra un minuto'); closeSheet(); viewAgenda(); } }, 'Riprova calendario'));
    const canMove = future(S.day.date, c.hour);
    row.append(
      el('button', { class: 'btn', type: 'button', onclick: () => editStudent({ id: c.student_id, name: c.student_name, phone: c.student_phone }, viewAgenda) }, 'Allievo'),
      canMove ? el('button', { class: 'btn', type: 'button', onclick: () => guestsForm(c) }, 'Partecipanti') : null,
      canMove ? el('button', { class: 'btn', type: 'button', onclick: () => moveForm(c) }, 'Sposta') : null,
      confirmBtn('Annulla lezione', 'Conferma annullamento', async () => { await rpc('admin_cancel', { p_id: c.booking_id }); closeSheet(); toast('Lezione annullata. L\'allievo riceve l\'avviso se ha WhatsApp attivo.'); viewAgenda(); }),
      el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'));
    openSheet(head, kv, el('div', 'label', 'Conferme'), toggles, att, row);
  }
  function confLine(c) {
    return el('div', 'muted small', `Conferme — sala: ${c.room_confirmed ? 'sì' : 'no'} · insegnante: ${c.teacher_confirmed ? 'sì' : 'no'} · allievo: ${c.student_confirmed ? 'sì' : 'no'}`);
  }

  // ---------- spostamento (trascinamento o modulo) ----------
  /** Sposta la lezione; se l'insegnante è fuori turno chiede conferma e riprova forzando. */
  async function moveBooking(c, to, { force = false, quiet = false } = {}) {
    try {
      const b = await rpc('admin_move_booking', P({ id: c.booking_id, date: to.date, hour: to.hour, room_id: to.room_id, teacher_id: to.teacher_id, force }));
      closeSheet();
      toast(`${who(c)} → ${b.room}, ${b.date === S.date ? '' : fmtShort(b.date) + ' '}${pad(b.hour)}:00 con ${b.teacher}`);
      if (to.date !== S.date) S.date = to.date;
      viewAgenda();
      return true;
    } catch (e) {
      if (!force && /non è in turno/.test(e.message)) {
        openSheet(el('h3', null, 'Insegnante fuori turno'), el('div', null, `${e.message} Vuoi spostare la lezione comunque?`),
          el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); renderBoard(); } }, 'No'),
            el('button', { class: 'btn primary', type: 'button', onclick: () => moveBooking(c, to, { force: true }) }, 'Sposta comunque')));
        return false;
      }
      if (quiet) throw e;
      toast(e.message); renderBoard();
      return false;
    }
  }

  function moveForm(c) {
    const date = el('input', { type: 'date', id: 'mv-date', value: S.day.date, min: S.status.today });
    const hour = hourSelect('mv-hour', c.hour, 6, 23);
    const mins = el('select', { id: 'mv-min' }, ...[0, 15, 30, 45].map((m) => el('option', { value: m, selected: m === (c.start_min || 0) }, `:${pad(m)}`)));
    const room = el('select', { id: 'mv-room' }, ...activeRooms().map((r) => el('option', { value: r.id, selected: r.id === c.room_id }, r.name)));
    const teacher = el('select', { id: 'mv-t' }, ...activeTeachers().map((t) => el('option', { value: t.id, selected: t.id === c.teacher_id }, `${t.name} · ${t.style}`)));
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Sposta');
    save.onclick = async () => {
      err.textContent = ''; save.disabled = true;
      try {
        const to = { date: date.value, hour: Number(hour.value), room_id: Number(room.value), teacher_id: Number(teacher.value) };
        const m = Number(mins.value);
        if (m !== (c.start_min || 0)) await rpc('admin_set_start_min', { p_id: c.booking_id, p_min: m });
        if (to.date === S.day.date && to.hour === c.hour && to.room_id === c.room_id && to.teacher_id === c.teacher_id) { closeSheet(); toast(`Inizio alle ${pad(to.hour)}:${pad(m)}`); viewAgenda(); }
        else await moveBooking(c, to, { quiet: true });
      }
      catch (e) { err.textContent = e.message; } finally { save.disabled = false; }
    };
    openSheet(el('div', null, el('h3', null, `Sposta la lezione di ${who(c)}`), el('div', 'meta', `Ora: ${cap(fmtDay(S.day.date))}, ${hm(c)} · ${roomById(c.room_id)?.name || ''}`)),
      el('div', 'fields', field('Giorno', date), field('Ora', hour), field('Minuti', mins)), el('div', 'fields', field('Sala', room), field('Insegnante', teacher)),
      el('div', 'muted small', 'La griglia resta a ore piene: con i minuti indichi l\'inizio esatto (es. 18:30). L\'allievo riceve il nuovo orario su WhatsApp (se attivo) e l\'invito aggiornato nel calendario.'),
      err, el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
  }

  function guestsForm(c) {
    const rows = (c.guests || []).map((g) => ({ ...g }));
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    const render = () => box.replaceChildren(...rows.map((g, i) => {
      const n = el('input', { type: 'text', id: `gs-n-${i}`, value: g.name || '', placeholder: 'Nome', 'aria-label': 'Nome', style: 'flex:1;min-width:120px' });
      const m = el('input', { type: 'email', id: `gs-e-${i}`, value: g.email || '', placeholder: 'Email (per l\'invito)', 'aria-label': 'Email', style: 'flex:2;min-width:160px' });
      n.oninput = () => (g.name = n.value); m.oninput = () => (g.email = m.value);
      return el('div', 'shift', n, m, el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Rimuovi', onclick: () => { rows.splice(i, 1); render(); } }, '×'));
    }), rows.length < 3 ? el('button', { class: 'btn', type: 'button', style: 'align-self:flex-start', onclick: () => { rows.push({ name: '', email: '' }); render(); } }, '+ Partecipante') : null);
    if (!rows.length) rows.push({ name: '', email: '' });
    render();
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Salva');
    save.onclick = async () => {
      err.textContent = '';
      try { await rpc('admin_set_booking_guests', { p_id: c.booking_id, p_guests: rows }); closeSheet(); toast('Partecipanti salvati'); viewAgenda(); }
      catch (e) { err.textContent = e.message; }
    };
    openSheet(el('div', null, el('h3', null, 'Partecipanti'), el('div', 'meta', `Lezione di ${c.student_name || 'Allievo'} · ${pad(c.hour)}:00`)),
      el('div', 'muted small', 'Per le lezioni di coppia o di gruppo. Chi ha l\'email riceve l\'invito nel calendario con l\'avviso prima della lezione (quando Outlook della scuola è collegato).'),
      box, err, el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
  }

  // ---------- rinomina dall'agenda ----------
  function renameRoom(id) {
    const r = roomById(id); if (!r) return;
    const n = el('input', { type: 'text', id: 'rn-name', value: r.name }), i = el('input', { type: 'text', id: 'rn-info', value: r.info || '' });
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try { await rpc('admin_save_room', { p_id: r.id, p_name: n.value, p_info: i.value, p_active: r.active }); await loadBase(); closeSheet(); toast('Sala rinominata'); viewAgenda(); }
      catch (e) { err.textContent = e.message; }
    } }, 'Salva');
    openSheet(el('h3', null, 'Rinomina sala'), field('Nome', n), field('Descrizione', i), err, el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
    setTimeout(() => n.select(), 50);
  }
  function renameTeacher(id) {
    const t = teacherById(id); if (!t) return;
    const n = el('input', { type: 'text', id: 'rn-name', value: t.name }), st = el('input', { type: 'text', id: 'rn-style', value: t.style || '' });
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'button', onclick: async () => {
      try {
        await rpc('admin_save_teacher', { p_id: t.id, p_name: n.value, p_style: st.value, p_color: t.color, p_phone: t.phone || '', p_active: !!t.active, p_shifts: null });
        await loadBase(); closeSheet(); toast('Insegnante aggiornato'); viewAgenda();
      } catch (e) { err.textContent = e.message; }
    } }, 'Salva');
    openSheet(el('h3', null, 'Modifica insegnante'), field('Nome', n), field('Stili (es. Latino americano · Tango)', st),
      el('div', 'muted small', 'Turni, colore e accesso si cambiano in Impostazioni.'), err,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
    setTimeout(() => n.select(), 50);
  }

  // ---------- trascinamento (mouse e touch) ----------
  let dragOn = false;
  document.addEventListener('touchmove', (e) => { if (dragOn) e.preventDefault(); }, { passive: false });
  function enableDrag(grid) {
    grid.querySelectorAll('.slot.draggable').forEach((node) => node.addEventListener('pointerdown', (e) => pressStart(e, node)));
  }
  function pressStart(e, node) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const bid = Number(node.dataset.bid);
    const c = S.day.cells.find((x) => x.booking_id === bid); if (!c) return;
    const touch = e.pointerType !== 'mouse';
    const x0 = e.clientX, y0 = e.clientY; let started = false, ghost = null, target = null, timer = null, lastX = x0, lastY = y0, raf = 0;
    const board = $('ag-board');
    const begin = () => {
      started = true; dragOn = true; navigator.vibrate?.(12);
      const r = node.getBoundingClientRect();
      ghost = node.cloneNode(true); ghost.classList.add('ghost'); ghost.style.width = r.width + 'px'; ghost.style.height = r.height + 'px';
      ghost.dataset.dx = String(lastX - r.left); ghost.dataset.dy = String(lastY - r.top);
      document.body.append(ghost); node.classList.add('dragging'); document.body.classList.add('is-dragging');
      place(); tick();
    };
    const place = () => { if (ghost) ghost.style.transform = `translate(${lastX - Number(ghost.dataset.dx)}px, ${lastY - Number(ghost.dataset.dy)}px)`; };
    const tick = () => { // scorrimento automatico vicino ai bordi
      if (!started) return;
      const edge = 56, sp = 14;
      if (lastY < edge) window.scrollBy(0, -sp); else if (lastY > innerHeight - edge) window.scrollBy(0, sp);
      const br = board.getBoundingClientRect();
      if (lastX < br.left + edge) board.scrollLeft -= sp; else if (lastX > br.right - edge) board.scrollLeft += sp;
      hit(); raf = requestAnimationFrame(tick);
    };
    const hit = () => {
      const t = document.elementFromPoint(lastX, lastY)?.closest('[data-drop]');
      if (t !== target) { target?.classList.remove('drop-over'); target = t || null; target?.classList.add('drop-over'); }
    };
    const move = (ev) => {
      lastX = ev.clientX; lastY = ev.clientY;
      if (!started) {
        if (Math.hypot(lastX - x0, lastY - y0) < 8) return;
        if (touch) { end(); return; }   // sul telefono serve tenere premuto: un movimento rapido è uno scorrimento
        begin();
      }
      ev.preventDefault(); place();
    };
    const end = () => {
      clearTimeout(timer); cancelAnimationFrame(raf);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', end);
      node.removeEventListener('contextmenu', noMenu);
      ghost?.remove(); node.classList.remove('dragging'); document.body.classList.remove('is-dragging'); target?.classList.remove('drop-over');
      dragOn = false;
    };
    const up = () => {
      const t = target, was = started; end();
      if (!was) return;
      node.dataset.dragged = '1'; setTimeout(() => delete node.dataset.dragged, 400);
      if (t) dropOn(c, t);
    };
    const noMenu = (ev) => ev.preventDefault();
    node.addEventListener('contextmenu', noMenu);
    addEventListener('pointermove', move, { passive: false }); addEventListener('pointerup', up); addEventListener('pointercancel', end);
    if (touch) timer = setTimeout(begin, 380);
  }
  function dropOn(c, t) {
    const hour = Number(t.dataset.hour), g = S.day;
    const to = { date: g.date, hour, room_id: c.room_id, teacher_id: c.teacher_id };
    if (t.dataset.room) to.room_id = Number(t.dataset.room);
    if (t.dataset.teacher) {
      to.teacher_id = Number(t.dataset.teacher);
      if (hour !== c.hour) { // stessa sala se è libera a quell'ora, altrimenti la prima libera
        const freeAt = (rid) => { const x = g.cells.find((y) => y.hour === hour && y.room_id === rid); return x && (x.status === 'free' || x.status === 'off'); };
        if (!freeAt(c.room_id)) {
          const alt = g.rooms.find((r) => freeAt(r.id));
          if (!alt) { toast(`Nessuna sala libera alle ${pad(hour)}:00`); return; }
          to.room_id = alt.id;
        }
      }
    }
    moveBooking(c, to);
  }

  function bookingForm({ date, hour, room_id = null, teacher_id = null }) {
    const g = S.day;
    const cellsAtHour = g.cells.filter((x) => x.hour === hour);
    const freeRoomIds = cellsAtHour.filter((x) => x.status === 'free' || x.status === 'off').map((x) => x.room_id);
    const busyTeachers = new Set(cellsAtHour.filter((x) => x.status === 'booked').map((x) => x.teacher_id));
    const inShift = (tid) => g.shifts.some((s) => s.teacher_id === tid && hour >= s.start_hour && hour < s.end_hour);
    const blockedT = (tid) => g.blocks.some((b) => b.teacher_id === tid && hour >= b.start_hour && hour < b.end_hour);

    // allievo
    let chosen = null;
    const search = el('input', { type: 'search', id: 'bf-q', placeholder: 'Cerca per nome o telefono', autocomplete: 'off' });
    const results = el('div', 'results'); results.hidden = true;
    const chosenBox = el('div', 'muted small', 'Nessun allievo selezionato');
    const newBox = el('div', 'fields', field('Telefono', el('input', { type: 'tel', id: 'bf-phone', placeholder: '+39 333 1234567' })), field('Nome e cognome', el('input', { type: 'text', id: 'bf-name' })));
    const consent = el('label', 'check', el('input', { type: 'checkbox', id: 'bf-wa' }), 'L\'allievo acconsente ai messaggi WhatsApp');
    const newWrap = el('div', { style: 'display:flex;flex-direction:column;gap:8px' }, newBox, consent); newWrap.hidden = true;
    const toggleNew = el('button', { class: 'btn', type: 'button' }, 'Nuovo allievo');
    toggleNew.onclick = () => { chosen = null; newWrap.hidden = !newWrap.hidden; toggleNew.textContent = newWrap.hidden ? 'Nuovo allievo' : 'Cerca allievo esistente'; search.parentElement.hidden = !newWrap.hidden; chosenBox.textContent = newWrap.hidden ? 'Nessun allievo selezionato' : ''; };
    let qT;
    search.oninput = () => {
      clearTimeout(qT); const q = search.value.trim(); if (q.length < 2) { results.hidden = true; return; }
      qT = setTimeout(async () => {
        const list = await rpc('admin_students', { p_q: q.replace(/^\+/, '') });
        results.replaceChildren(...list.slice(0, 12).map((s) => el('button', { type: 'button', onclick: () => { chosen = s; chosenBox.replaceChildren(el('b', null, s.name || '(senza nome)'), ` · ${phone(s.phone)}`); results.hidden = true; search.value = ''; } }, el('b', null, s.name || '(senza nome)'), ` · ${phone(s.phone)}`)));
        if (!list.length) results.replaceChildren(el('div', { class: 'muted small', style: 'padding:8px 10px' }, 'Nessun allievo trovato: usa “Nuovo allievo”.'));
        results.hidden = false;
      }, 200);
    };

    const roomSel = el('select', { id: 'bf-room' });
    for (const r of activeRooms()) {
      const ok = freeRoomIds.includes(r.id);
      roomSel.append(el('option', { value: r.id, disabled: !ok, selected: r.id === room_id || (!room_id && ok && !roomSel.value) }, `${r.name}${ok ? '' : ' (occupata)'}`));
    }
    if (room_id) roomSel.value = room_id; else { const first = activeRooms().find((r) => freeRoomIds.includes(r.id)); if (first) roomSel.value = first.id; }
    const teachSel = el('select', { id: 'bf-teacher' });
    for (const t of activeTeachers()) {
      const busy = busyTeachers.has(t.id) || blockedT(t.id);
      const tag = busy ? ' (già impegnato)' : inShift(t.id) ? '' : ' (fuori turno)';
      teachSel.append(el('option', { value: t.id, disabled: busy }, `${t.name} · ${t.style}${tag}`));
    }
    const prefer = teacher_id || activeTeachers().find((t) => inShift(t.id) && !busyTeachers.has(t.id) && !blockedT(t.id))?.id;
    if (prefer) teachSel.value = prefer;
    const note = el('textarea', { id: 'bf-note', maxlength: 200, placeholder: 'Nota per l\'insegnante (facoltativa)' });
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Prenota');
    save.onclick = async () => {
      err.textContent = '';
      const body = { date, hour, room_id: Number(roomSel.value), teacher_id: Number(teachSel.value), note: note.value.trim() };
      if (!inShift(body.teacher_id)) body.force = true;
      if (chosen) body.student_id = chosen.id;
      else if (!newWrap.hidden) { body.phone = $('bf-phone').value; body.name = $('bf-name').value; body.wa_consent = $('bf-wa').checked; }
      else { err.textContent = 'Scegli un allievo o inseriscine uno nuovo.'; return; }
      save.disabled = true;
      try { await rpc('admin_book', P(body)); closeSheet(); toast('Lezione prenotata'); viewAgenda(); }
      catch (e) { err.textContent = e.message; save.disabled = false; }
    };
    openSheet(
      el('div', null, el('h3', null, `Nuova lezione · ${pad(hour)}:00`), el('div', 'meta', cap(fmtDay(date)))),
      el('div', 'field', el('div', 'lbl', 'Allievo'), el('div', { style: 'display:flex;gap:8px' }, search, toggleNew)), results, chosenBox, newWrap,
      el('div', 'fields', field('Sala', roomSel), field('Insegnante', teachSel)), note, err,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
    setTimeout(() => search.focus(), 50);
  }

  /** CSV con separatore ";" e BOM: si apre direttamente in Excel in italiano. */
  function exportCsv(rows, from, to) {
    if (!rows.length) { toast('Nessuna prenotazione da esportare con questi filtri'); return; }
    const esc = (v) => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const head = ['Data', 'Ora', 'Sala', 'Insegnante', 'Allievo', 'Telefono', 'Stato', 'Canale', 'Nota', 'Creata il'];
    const lines = rows.map((r) => [r.date.split('-').reverse().join('/'), hm(r), r.room_name, r.teacher_name, r.student_name,
      phone(r.student_phone), r.status, SRC[r.source] || r.source, r.note, new Date(r.created_at).toLocaleString('it-IT')].map(esc).join(';'));
    const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `prenotazioni_${from}_${to}.csv` });
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ================= PRENOTAZIONI =================
  async function viewList() {
    const L = S.list; L.from ||= S.status.today; L.to ||= addDays(S.status.today, 30);
    const from = el('input', { type: 'date', id: 'pl-from', value: L.from }), to = el('input', { type: 'date', id: 'pl-to', value: L.to });
    const tSel = el('select', { id: 'pl-t' }, el('option', { value: '' }, 'Tutti gli insegnanti'), ...S.teachers.map((t) => el('option', { value: t.id, selected: String(t.id) === String(L.teacher) }, t.name)));
    const rSel = el('select', { id: 'pl-r' }, el('option', { value: '' }, 'Tutte le sale'), ...S.rooms.map((r) => el('option', { value: r.id, selected: String(r.id) === String(L.room) }, r.name)));
    const stSel = el('select', { id: 'pl-s' }, el('option', { value: '' }, 'Tutti gli stati'), el('option', { value: 'confermata', selected: L.status === 'confermata' }, 'Confermate'), el('option', { value: 'annullata', selected: L.status === 'annullata' }, 'Annullate'));
    const q = el('input', { type: 'search', id: 'pl-q', placeholder: 'Allievo o telefono', value: L.q || '' });
    const exp = el('button', { class: 'btn', type: 'button' }, 'Esporta Excel (CSV)');
    let lastRows = [];
    exp.onclick = () => exportCsv(lastRows, L.from, L.to);
    const body = el('div', null, el('div', 'muted', 'Caricamento…'));
    $('main').replaceChildren(el('div', 'toolbar', el('h1', { class: 'grow' }, 'Prenotazioni'), exp),
      el('div', 'toolbar', from, '→', to, tSel, rSel, stSel, q), body);
    const load = async () => {
      Object.assign(L, { from: from.value, to: to.value, teacher: tSel.value, room: rSel.value, status: stSel.value, q: q.value.trim().replace(/^\+/, '') });
      try {
        const rows = await rpc('admin_bookings', { p_from: L.from, p_to: L.to, p_teacher: L.teacher ? Number(L.teacher) : null,
          p_room: L.room ? Number(L.room) : null, p_status: L.status || null, p_q: L.q || null });
        lastRows = rows;
        if (!rows.length) { body.replaceChildren(el('div', 'closedday', 'Nessuna prenotazione con questi filtri.')); return; }
        const tb = el('tbody');
        for (const b of rows) {
          const tr = el('tr', b.status === 'annullata' ? 'cancelled' : '',
            el('td', 'num', fmtShort(b.date)), el('td', 'num', hm(b)), el('td', null, b.room_name), el('td', null, b.teacher_name),
            el('td', null, b.student_name || '—', el('div', 'muted small', phone(b.student_phone))), el('td', null, b.note || ''),
            el('td', null, el('span', 'pill', SRC[b.source] || b.source)),
            el('td', null, b.status === 'confermata'
              ? (b.sync_error ? el('span', { class: 'pill bad', title: b.sync_error }, 'Calendario non aggiornato') : el('span', 'pill ok', 'Confermata'))
              : el('span', 'pill off', `Annullata${b.cancelled_by ? ' (' + b.cancelled_by + ')' : ''}`)));
          tb.append(tr);
        }
        body.replaceChildren(el('div', 'muted small', `${rows.length} righe`), el('div', 'table-wrap', el('table', null,
          el('thead', null, el('tr', null, ...['Data', 'Ora', 'Sala', 'Insegnante', 'Allievo', 'Nota', 'Canale', 'Stato'].map((h) => el('th', null, h)))), tb)));
      } catch (e) { body.replaceChildren(el('div', 'err', e.message)); }
    };
    let t; for (const i of [from, to, tSel, rSel, stSel]) i.onchange = load; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    load();
  }

  // ================= ALLIEVI =================
  async function viewStudents() {
    const q = el('input', { type: 'search', id: 'st-q', placeholder: 'Cerca per nome, telefono o n. tessera', value: S.students.q });
    const body = el('div', null, el('div', 'muted', 'Caricamento…'));
    $('main').replaceChildren(el('div', 'toolbar', el('h1', { class: 'grow' }, 'Allievi e tessere'), q,
      el('button', { class: 'btn primary', type: 'button', onclick: () => newStudent(load) }, '+ Nuovo allievo')), body);
    const load = async () => {
      S.students.q = q.value.trim();
      const rows = await rpc('admin_students', { p_q: S.students.q.replace(/^\+/, '') });
      if (!rows.length) { body.replaceChildren(el('div', 'closedday', S.students.q ? 'Nessun allievo trovato.' : 'Ancora nessun allievo: si registrano da soli al primo accesso all\'app.')); return; }
      if (rows.length === 1 && /^[A-Za-z0-9]{1,6}-\d{4}$/.test(S.students.q) && rows[0].member_no?.toUpperCase() === S.students.q.toUpperCase() && !S.students.opened) { S.students.opened = true; editStudent(rows[0], load); }
      const tb = el('tbody');
      for (const s of rows) {
        tb.append(el('tr', { style: 'cursor:pointer', onclick: () => editStudent(s, load) },
          el('td', null, el('b', null, s.name || '(senza nome)')), el('td', 'num', phone(s.phone), s.email ? el('div', 'muted small', s.email) : null),
          el('td', 'num', s.member_no || '—', el('div', 'small', !s.member_until ? el('span', 'pill off', 'da attivare') : s.member_until < S.status.today ? el('span', 'pill bad', 'scaduta') : el('span', 'pill ok', `fino al ${s.member_until.split('-').reverse().join('/')}`))),
          el('td', 'num', s.lessons),
          el('td', 'num', s.last_date ? fmtShort(s.last_date) : '—'),
          el('td', null, s.wa_consent ? el('span', 'pill ok', 'Sì') : el('span', 'pill off', 'No')), el('td', 'muted', s.notes || '')));
      }
      body.replaceChildren(el('div', 'table-wrap', el('table', null, el('thead', null, el('tr', null, ...['Nome', 'Telefono', 'Tessera', 'Lezioni', 'Ultima', 'WhatsApp', 'Note'].map((h) => el('th', null, h)))), tb)));
    };
    let t; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    load().catch((e) => body.replaceChildren(el('div', 'err', e.message)));
  }
  async function editStudent(s0, reload) {
    let s;
    try { s = await rpc('admin_student', { p_id: s0.id }); } catch (e) { toast(e.message); return; }
    const STATUS = { attiva: ['ok', 'Attiva'], scaduta: ['bad', 'Scaduta'], da_attivare: ['off', 'Da attivare'] };
    const dmy = (k) => (k ? k.split('-').reverse().join('/') : '—');
    const inp = (id, type, v, extra = {}) => el('input', { type, id, value: v ?? '', ...extra });
    const name = inp('es-name', 'text', s.name), email = inp('es-email', 'email', s.email, { placeholder: 'Per gli inviti nel calendario' });
    const birth = inp('es-birth', 'date', s.birth_date), cf = inp('es-cf', 'text', s.tax_code, { maxlength: 16 }), addr = inp('es-addr', 'text', s.address);
    const since = inp('es-since', 'date', s.member_since), until = inp('es-until', 'date', s.member_until), med = inp('es-med', 'date', s.medical_until);
    const notes = el('textarea', { id: 'es-notes', maxlength: 1000 }); notes.value = s.notes || '';
    const wa = el('input', { type: 'checkbox', id: 'es-wa', checked: !!s.wa_consent });
    const err = el('div', 'err');
    const [cls, lbl] = STATUS[s.status] || STATUS.da_attivare;
    const p = s.points;
    const medWarn = s.medical_until && s.medical_until < S.status.today ? el('div', null, el('span', 'pill bad', 'Certificato medico scaduto')) : null;
    const card = el('div', 'mini-card ' + s.status,
      el('div', null, el('b', null, s.name || 'Allievo'), el('div', 'mono', s.member_no)),
      el('div', { style: 'text-align:right' }, el('span', `pill ${cls}`, lbl), el('div', 'small', s.member_until ? `fino al ${dmy(s.member_until)}` : 'non attiva')));
    const renew = el('button', { class: 'btn', type: 'button', onclick: async () => {
      try { await rpc('admin_renew_member', { p_id: s.id }); toast('Tessera aggiornata'); reload && reload(); editStudent(s, reload); } catch (e) { toast(e.message); }
    } }, s.status === 'attiva' ? 'Rinnova per la stagione successiva' : 'Attiva per questa stagione');
    const ptsBox = el('div', 'card', el('div', 'label', 'Punti fedeltà'),
      el('div', 'pts-row', el('b', 'pts-big', String(p.total)), el('span', 'muted', `punti · ${p.lessons_done} lezioni svolte × ${p.per_lesson}${p.redeemed ? ` · ${p.redeemed} già usati` : ''}`)),
      el('div', 'row',
        el('button', { class: 'btn primary', type: 'button', disabled: p.total < p.reward, onclick: async () => {
          try { await rpc('admin_points', { p_id: s.id, p_delta: -p.reward, p_reason: 'premio', p_note: p.reward_label || 'Premio' }); toast('Premio registrato'); editStudent(s, reload); } catch (e) { toast(e.message); }
        } }, `Usa premio: ${p.reward_label || 'premio'} (−${p.reward})`),
        el('button', { class: 'btn', type: 'button', onclick: () => pointsForm(s, reload) }, 'Rettifica punti')),
      s.ledger.length ? el('div', 'muted small', s.ledger.slice(0, 5).map((l) => `${new Date(l.created_at).toLocaleDateString('it-IT')} ${l.delta > 0 ? '+' : ''}${l.delta} ${l.reason}${l.note ? ' (' + l.note + ')' : ''}`).join(' · ')) : null);
    const up = s.upcoming.length
      ? el('div', 'muted small', 'Prossime lezioni: ' + s.upcoming.map((b) => `${fmtShort(b.date)} ${hm(b)} ${b.room} con ${b.teacher}${b.student_confirmed ? ' ✓' : ''}`).join(' · '))
      : el('div', 'muted small', 'Nessuna lezione in programma.');
    const wl = s.waitlist.length ? el('div', 'muted small', 'In lista d\'attesa: ' + s.waitlist.map((w) => `${fmtShort(w.date)} ${pad(w.hour)}:00${w.teacher ? ' con ' + w.teacher : ''}`).join(' · ')) : null;
    const pushBtn = s.push ? el('button', { class: 'btn', type: 'button', onclick: async () => { try { await rpc('admin_push_test', { p_student_id: s.id }); toast('Notifica di prova inviata'); } catch (e) { toast(e.message); } } }, 'Notifica di prova') : null;
    openSheet(el('div', null, el('h3', null, s.name || 'Allievo'), el('div', 'meta', `${phone(s.phone)} · ${s.has_app ? 'usa l\'app' : 'non ha ancora l\'app'}${s.push ? ' · notifiche attive' : ''}`)),
      card, medWarn, el('div', 'row', renew, pushBtn),
      el('div', 'fields', field('Iscritto dal', since), field('Tessera valida fino al', until), field('Certificato medico fino al', med)),
      ptsBox, up, wl,
      el('div', 'label', 'Anagrafica'),
      el('div', 'fields', field('Nome e cognome', name), field('Email', email), field('Data di nascita', birth), field('Codice fiscale', cf)),
      field('Indirizzo', addr), field('Note interne (non visibili all\'allievo)', notes),
      el('label', 'check', wa, 'Riceve messaggi WhatsApp (consenso dato)'),
      el('div', 'muted small', `Lezioni annullate: ${s.stats.cancelled} · assenze: ${s.stats.absent}`), err,
      el('div', 'row',
        el('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); S.list = { q: s.phone, from: addDays(S.status.today, -180), to: addDays(S.status.today, 60) }; go('prenotazioni'); } }, 'Prenotazioni'),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try {
            await rpc('admin_save_student', { p_id: s.id, p_data: { name: name.value, email: email.value, birth_date: birth.value, tax_code: cf.value, address: addr.value,
              member_since: since.value, member_until: until.value, medical_until: med.value, notes: notes.value, wa_consent: wa.checked } });
            closeSheet(); toast('Scheda salvata'); reload && reload();
          } catch (e) { err.textContent = e.message; }
        } }, 'Salva')));
  }
  function pointsForm(s, reload) {
    const n = el('input', { type: 'number', id: 'pf-n', placeholder: 'es. 20 oppure -10', style: 'width:140px' });
    const why = el('input', { type: 'text', id: 'pf-why', placeholder: 'Motivo (facoltativo)' });
    const err = el('div', 'err');
    openSheet(el('h3', null, `Rettifica punti · ${s.name}`), field('Punti (+ aggiunge, − toglie)', n), field('Motivo', why), err,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: () => editStudent(s, reload) }, 'Indietro'),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const v = parseInt(n.value, 10); if (!v) { err.textContent = 'Scrivi un numero diverso da zero.'; return; }
          try { await rpc('admin_points', { p_id: s.id, p_delta: v, p_reason: 'rettifica', p_note: why.value }); toast('Punti aggiornati'); editStudent(s, reload); } catch (e) { err.textContent = e.message; }
        } }, 'Salva')));
  }
  function newStudent(reload) {
    const ph = el('input', { type: 'tel', id: 'ns-phone', placeholder: '+39 333 1234567' }), nm = el('input', { type: 'text', id: 'ns-name' });
    const err = el('div', 'err');
    openSheet(el('h3', null, 'Nuovo allievo'), field('Telefono', ph), field('Nome e cognome', nm),
      el('div', 'muted small', 'Riceve subito il numero di tessera. Quando accede all\'app con questo numero ritrova la sua scheda.'), err,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try { const s = await rpc('admin_create_student', { p_phone: ph.value, p_name: nm.value }); reload && reload(); editStudent(s, reload); } catch (e) { err.textContent = e.message; }
        } }, 'Crea')));
  }

  // ================= OCCUPAZIONE E CONFERME =================
  async function viewOccupancy() {
    S.occ ||= S.status.today;
    const body = el('div', null, el('div', 'muted', 'Caricamento…'));
    $('main').replaceChildren(el('div', 'toolbar', el('h1', { class: 'grow' }, 'Occupazione e conferme'), el('span', 'muted', `${fmtShort(S.occ)} – ${fmtShort(addDays(S.occ, 6))}`),
      el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Settimana precedente', onclick: () => { S.occ = addDays(S.occ, -7); viewOccupancy(); } }, '‹'),
      el('button', { class: 'btn', type: 'button', onclick: () => { S.occ = S.status.today; viewOccupancy(); } }, 'Da oggi'),
      el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Settimana successiva', onclick: () => { S.occ = addDays(S.occ, 7); viewOccupancy(); } }, '›')), body);
    let o;
    try { o = await rpc('admin_occupancy', { p_start: S.occ }); } catch (e) { body.replaceChildren(el('div', 'err', e.message)); return; }
    const pct = (b, t) => (t ? Math.round((b / t) * 100) : 0);
    const sum = (rows) => rows.reduce((a, r) => { r.days.forEach((d) => { a.b += d.booked; a.o += d.open; }); return a; }, { b: 0, o: 0 });
    const R = sum(o.rooms), Tt = sum(o.teachers);
    const fut = o.lessons.filter((l) => !l.past);
    const sc = fut.filter((l) => l.student_confirmed).length;
    const kpi = (n, l, sub) => el('div', 'stat', el('b', null, n), el('span', null, l), sub ? el('span', 'muted small', sub) : null);
    const heat = (b, t) => { const v = pct(b, t); return el('td', { class: 'heat', style: `--h:${t ? v / 100 : 0}` }, t ? `${b}/${t}` : '—', t ? el('small', null, ` ${v}%`) : null); };
    const table = (title, rows, dot) => el('div', 'card', el('h2', null, title), el('div', 'table-wrap', el('table', 'occ',
      el('thead', null, el('tr', null, el('th', null, ''), ...o.days.map((d) => el('th', null, fmtShort(d.date))), el('th', null, 'Settimana'))),
      el('tbody', null, ...rows.map((r) => {
        const t = r.days.reduce((a, d) => ({ b: a.b + d.booked, o: a.o + d.open }), { b: 0, o: 0 });
        return el('tr', null, el('th', null, dot ? el('i', { class: 'dot', style: `--tc:${r.color}` }) : null, ' ', r.name), ...r.days.map((d) => heat(d.booked, d.open)), heat(t.b, t.o));
      })))));
    const pending = fut.filter((l) => !(l.room_confirmed && l.teacher_confirmed && l.student_confirmed));
    const confRow = (l) => {
      const btn = (k, f, label) => el('button', { class: 'tog small' + (l[f] ? ' on' : ''), type: 'button', onclick: async () => {
        try { await rpc('admin_confirm', { p_id: l.id, p_what: k, p_value: !l[f] }); viewOccupancy(); } catch (e) { toast(e.message); } } }, (l[f] ? '✓ ' : '') + label);
      return el('tr', null, el('td', 'num', `${fmtShort(l.date)} ${hm(l)}`), el('td', null, l.room), el('td', null, l.teacher),
        el('td', null, [l.student, ...(l.guests || []).map((g) => g.name)].join(' + ')),
        el('td', null, el('div', 'conf-toggles', btn('sala', 'room_confirmed', 'Sala'), btn('insegnante', 'teacher_confirmed', 'Insegnante'), btn('allievo', 'student_confirmed', 'Allievo'))));
    };
    body.replaceChildren(
      el('div', 'stats', kpi(String(o.lessons.length), 'lezioni nei 7 giorni'), kpi(`${pct(R.b, R.o)}%`, 'occupazione sale', `${R.b} ore su ${R.o}`),
        kpi(`${pct(Tt.b, Tt.o)}%`, 'occupazione insegnanti', `${Tt.b} ore su ${Tt.o} in turno`),
        kpi(`${sc}/${fut.length}`, 'allievi confermati'), kpi(String(o.waitlist), 'in lista d\'attesa')),
      table('Sale', o.rooms, false), table('Insegnanti (ballerini)', o.teachers, true),
      el('div', 'card', el('h2', null, `Da confermare (${pending.length})`),
        el('div', 'muted small', 'Sala: la segreteria conferma che è pronta. Insegnante: conferma dalla sua agenda (o la segreteria per lui). Allievo: dal pulsante del promemoria WhatsApp, dall\'app o qui.'),
        pending.length ? el('div', 'table-wrap', el('table', null, el('thead', null, el('tr', null, ...['Quando', 'Sala', 'Insegnante', 'Allievo', 'Conferme'].map((h) => el('th', null, h)))), el('tbody', null, ...pending.map(confRow))))
          : el('div', 'muted', 'Tutte le lezioni della settimana sono confermate.')));
  }

  // ================= LISTA D'ATTESA =================
  async function viewWaitlist() {
    const from = el('input', { type: 'date', id: 'wl-from', value: S.status.today }), to = el('input', { type: 'date', id: 'wl-to', value: addDays(S.status.today, 30) });
    const body = el('div', null, el('div', 'muted', 'Caricamento…'));
    const STATUS = { attiva: ['', 'In attesa'], avvisato: ['ok', 'Avvisato'], prenotato: ['ok', 'Ha prenotato'], annullata: ['off', 'Tolto'] };
    const load = async () => {
      let rows;
      try { rows = await rpc('admin_waitlist', { p_from: from.value, p_to: to.value }); } catch (e) { body.replaceChildren(el('div', 'err', e.message)); return; }
      if (!rows.length) { body.replaceChildren(el('div', 'closedday', 'Nessuno in lista d\'attesa in questo periodo. Gli allievi si iscrivono toccando una sala occupata nell\'app, o chiedendolo all\'assistente.')); return; }
      body.replaceChildren(el('div', 'table-wrap', el('table', null,
        el('thead', null, el('tr', null, ...['Quando', 'Allievo', 'Insegnante', 'Stato', 'Avvisi', ''].map((h) => el('th', null, h)))),
        el('tbody', null, ...rows.map((w) => {
          const [c, l] = STATUS[w.status] || ['', w.status];
          const open = w.status === 'attiva' || w.status === 'avvisato';
          return el('tr', { class: w.free_now && open ? 'hl' : '' },
            el('td', 'num', `${fmtShort(w.date)} ${pad(w.hour)}:00`),
            el('td', null, el('b', null, w.student_name || '(senza nome)'), el('div', 'muted small', phone(w.student_phone))),
            el('td', null, w.teacher || 'Qualsiasi'),
            el('td', null, el('span', `pill ${c}`, l), w.free_now && open ? el('div', 'small', el('b', null, 'Posto libero ora')) : null),
            el('td', 'small', [w.wa_consent && 'WhatsApp', w.push && 'notifica'].filter(Boolean).join(' + ') || 'nessuno: chiamare'),
            el('td', null, open ? el('div', 'row',
              el('button', { class: 'btn', type: 'button', onclick: async () => { try { await rpc('admin_waitlist_notify', { p_id: w.id }); toast('Avviso inviato'); load(); } catch (e) { toast(e.message); } } }, 'Avvisa'),
              el('button', { class: 'btn', type: 'button', onclick: async () => { try { await rpc('admin_waitlist_status', { p_id: w.id, p_status: 'annullata' }); load(); } catch (e) { toast(e.message); } } }, 'Togli')) : null));
        })))));
    };
    from.onchange = to.onchange = load;
    $('main').replaceChildren(el('div', 'toolbar', el('h1', { class: 'grow' }, 'Lista d\'attesa'), from, to,
      el('button', { class: 'btn primary', type: 'button', onclick: () => waitlistForm(load) }, '+ Aggiungi')),
      el('div', 'muted small', 'Quando una lezione viene annullata o spostata, chi è in lista per quell\'ora riceve subito WhatsApp e notifica sul telefono: prenota chi arriva prima.'), body);
    load();
  }
  function waitlistForm(reload) {
    const q = el('input', { type: 'search', id: 'wf-q', placeholder: 'Cerca allievo (nome, telefono, tessera)', autocomplete: 'off' });
    const res = el('div', 'results'); let picked = null;
    const date = el('input', { type: 'date', id: 'wf-date', value: S.status.today, min: S.status.today }), hour = hourSelect('wf-hour', 18, 6, 23);
    const teacher = el('select', { id: 'wf-t' }, el('option', { value: '' }, 'Qualsiasi insegnante'), ...activeTeachers().map((t) => el('option', { value: t.id }, t.name)));
    const note = el('input', { type: 'text', id: 'wf-note', placeholder: 'Nota (facoltativa)' });
    const err = el('div', 'err');
    let t; q.oninput = () => { picked = null; clearTimeout(t); t = setTimeout(async () => {
      const rows = q.value.trim() ? await rpc('admin_students', { p_q: q.value.trim().replace(/^\+/, '') }).catch(() => []) : [];
      res.replaceChildren(...rows.slice(0, 6).map((s) => el('button', { class: 'res', type: 'button', onclick: () => { picked = s; q.value = `${s.name} · ${phone(s.phone)}`; res.replaceChildren(); } },
        `${s.name || '(senza nome)'} · ${phone(s.phone)}${s.member_no ? ' · ' + s.member_no : ''}`)));
    }, 250); };
    openSheet(el('h3', null, 'Aggiungi alla lista d\'attesa'), field('Allievo', q), res,
      el('div', 'fields', field('Giorno', date), field('Ora', hour), field('Insegnante', teacher)), field('Nota', note), err,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          if (!picked) { err.textContent = 'Scegli un allievo dall\'elenco.'; return; }
          try {
            await rpc('admin_waitlist_add', { p_student_id: picked.id, p_date: date.value, p_hour: Number(hour.value), p_teacher_id: teacher.value ? Number(teacher.value) : null, p_note: note.value });
            closeSheet(); toast('Aggiunto alla lista d\'attesa'); reload();
          } catch (e) { err.textContent = e.message; }
        } }, 'Aggiungi')));
  }

  // ================= CHIUSURE E CORSI =================
  async function viewBlocks() {
    const body = el('div', null, el('div', 'muted', 'Caricamento…'));
    $('main').replaceChildren(
      el('div', 'toolbar', el('h1', { class: 'grow' }, 'Chiusure e corsi'), el('button', { class: 'btn primary', type: 'button', onclick: () => blockForm({ date: S.status.today }) }, 'Nuovo blocco')),
      el('p', { class: 'muted', style: 'margin:0;max-width:70ch' }, 'Un blocco rende non prenotabili una sala o tutta la scuola in certe ore: festività, corsi collettivi, prove del saggio. Se indichi un insegnante, anche lui risulta impegnato; un blocco con solo l\'insegnante segna un\'assenza.'),
      body);
    try {
      const rows = await rpc('admin_blocks', { p_from: S.status.today, p_to: addDays(S.status.today, 365) });
      if (!rows.length) { body.replaceChildren(el('div', 'closedday', 'Nessun blocco in programma.')); return; }
      const tb = el('tbody');
      for (const b of rows) tb.append(el('tr', null, el('td', 'num', fmtShort(b.date)), el('td', 'num', `${pad(b.start_hour)}–${pad(b.end_hour)}`),
        el('td', null, el('b', null, b.title)), el('td', null, b.room_name || (b.teacher_name ? '—' : 'Tutta la scuola')), el('td', null, b.teacher_name || '—'),
        el('td', null, confirmBtn('Elimina', 'Conferma', async () => { await rpc('admin_delete_block', { p_id: b.id }); toast('Blocco eliminato'); viewBlocks(); }))));
      body.replaceChildren(el('div', 'table-wrap', el('table', null, el('thead', null, el('tr', null, ...['Data', 'Ore', 'Motivo', 'Sala', 'Insegnante', ''].map((h) => el('th', null, h)))), tb)));
    } catch (e) { body.replaceChildren(el('div', 'err', e.message)); }
  }
  function blockDetails(b) {
    if (!b) return;
    openSheet(el('div', null, el('h3', null, b.title), el('div', 'meta', `${cap(fmtDay(b.date))} · ${pad(b.start_hour)}:00–${pad(b.end_hour)}:00`)),
      el('dl', 'kv', el('dt', null, 'Sala'), el('dd', null, b.room_name || (b.teacher_name ? '—' : 'Tutta la scuola')), el('dt', null, 'Insegnante'), el('dd', null, b.teacher_name || '—')),
      el('div', 'row', confirmBtn('Elimina blocco', 'Conferma', async () => { await rpc('admin_delete_block', { p_id: b.id }); closeSheet(); toast('Blocco eliminato'); if (S.view === 'agenda') viewAgenda(); else viewBlocks(); }),
        el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi')));
  }
  function blockForm({ date }) {
    const title = el('input', { type: 'text', id: 'bk-title', placeholder: 'Es. Festività, Corso hip hop ragazzi, Prove saggio' });
    const d1 = el('input', { type: 'date', id: 'bk-date', value: date }), d2 = el('input', { type: 'date', id: 'bk-until', value: date });
    const weekly = el('input', { type: 'checkbox', id: 'bk-weekly' });
    const a = hourSelect('bk-a', 15), z = hourSelect('bk-z', 22);
    const room = el('select', { id: 'bk-room' }, el('option', { value: '' }, 'Tutta la scuola / nessuna sala'), ...activeRooms().map((r) => el('option', { value: r.id }, r.name)));
    const teacher = el('select', { id: 'bk-t' }, el('option', { value: '' }, 'Nessuno'), ...activeTeachers().map((t) => el('option', { value: t.id }, t.name)));
    const err = el('div', 'err'); const conflicts = el('div');
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Crea blocco');
    const submit = async (force) => {
      err.textContent = ''; conflicts.replaceChildren();
      const body = { title: title.value.trim() || 'Non disponibile', date: d1.value, until: d2.value || d1.value, weekly: weekly.checked, start_hour: Number(a.value), end_hour: Number(z.value),
        room_id: room.value ? Number(room.value) : null, teacher_id: teacher.value ? Number(teacher.value) : null, force };
      try {
        const r = await rpc('admin_create_block', P(body));
        if (r.ok) { closeSheet(); toast(r.created > 1 ? `${r.created} blocchi creati` : 'Blocco creato'); if (S.view === 'agenda') viewAgenda(); else viewBlocks(); return; }
        err.textContent = r.error;
        if (r.conflicts?.length) {
          conflicts.replaceChildren(el('div', 'results', ...r.conflicts.map((c) => el('div', { style: 'padding:6px 10px' }, `${fmtShort(c.date)} ${pad(c.hour)}:00 · ${c.room} · ${c.student || 'Allievo'}`))),
            el('div', 'row', el('button', { class: 'btn danger', type: 'button', onclick: () => submit(true) }, 'Blocca comunque (le lezioni restano)')));
        }
      } catch (e) { err.textContent = e.message; }
    };
    save.onclick = () => submit(false);
    openSheet(el('h3', null, 'Nuovo blocco'), field('Motivo', title),
      el('div', 'fields', field('Dal', d1), field('Al', d2)), el('label', 'check', weekly, 'Solo lo stesso giorno della settimana (es. ogni martedì)'),
      el('div', 'fields', field('Dalle', a), field('Alle', z)), el('div', 'fields', field('Sala', room), field('Insegnante impegnato', teacher)),
      err, conflicts, el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
  }

  // ================= ACCESSI =================
  /** Crea (o aggiorna) un account con email e password tramite la Edge Function "accessi". */
  async function createAccess(body) {
    const { data, error } = await sb.functions.invoke('accessi', { body });
    if (error) {
      let msg = 'Non sono riuscito a creare l\'accesso. Riprova.';
      try { msg = (await error.context.json()).error || msg; } catch { /* risposta non leggibile */ }
      throw new Error(msg);
    }
    return data;
  }
  const randomPassword = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const v = crypto.getRandomValues(new Uint32Array(10)); return Array.from(v, (x) => a[x % a.length]).join(''); };
  function accessForm({ role, teacher = null, after }) {
    const email = el('input', { type: 'email', id: 'ac-email', value: teacher?.login_email || '', placeholder: 'nome@esempio.it', autocomplete: 'off' });
    const pass = el('input', { type: 'text', id: 'ac-pass', value: randomPassword(), autocomplete: 'off', style: 'font-family:var(--f-mono)' });
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'button' }, 'Crea accesso');
    save.onclick = async () => {
      err.textContent = ''; save.disabled = true;
      try {
        await createAccess({ role, teacher_id: teacher?.id, email: email.value, password: pass.value });
        const msg = `Accesso a ${appRoot()}segreteria/\nEmail: ${email.value.trim().toLowerCase()}\nPassword: ${pass.value}`;
        openSheet(el('h3', null, 'Accesso creato'), el('div', null, 'Manda questi dati alla persona (puoi copiarli):'),
          el('pre', { class: 'card', style: 'margin:0;white-space:pre-wrap;font-family:var(--f-mono);font-size:13px' }, msg),
          el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(msg); toast('Copiato'); } catch { toast('Seleziona il testo e copialo'); } } }, 'Copia'),
            el('button', { class: 'btn primary', type: 'button', onclick: closeSheet }, 'Fatto')));
        after && after();
      } catch (e) { err.textContent = e.message; save.disabled = false; }
    };
    openSheet(el('div', null, el('h3', null, role === 'teacher' ? `Accesso per ${teacher.name}` : 'Nuovo accesso segreteria'),
        el('div', 'meta', role === 'teacher' ? 'Vedrà l\'agenda con insegnanti e allievi, senza poter modificare.' : 'Potrà fare tutto quello che fai tu.')),
      field('Email', email), field('Password (almeno 8 caratteri)', pass),
      el('div', 'muted small', 'Se l\'email ha già un accesso, la password viene sostituita.'),
      err, el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), save));
  }
  function staffCard() {
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, el('div', 'muted small', 'Caricamento…'));
    const load = async () => {
      try {
        const a = await rpc('admin_accounts');
        list.replaceChildren(...a.staff.map((x) => el('div', 'shift', el('span', 'pill ok', x.email), x.me ? el('span', 'muted small', '(tu)') : null)));
      } catch (e) { list.replaceChildren(el('div', 'err', e.message)); }
    };
    load();
    return el('div', 'card', el('h2', null, 'Accessi della segreteria'), list,
      el('div', 'muted small', 'Gli insegnanti si abilitano dalla loro scheda qui sotto: vedono l\'agenda (insegnante e allievo) ma non possono modificarla.'),
      el('div', null, el('button', { class: 'btn', type: 'button', onclick: () => accessForm({ role: 'staff', after: load }) }, '+ Aggiungi persona')));
  }

  // ================= IMPOSTAZIONI =================
  async function viewSettings() {
    const main = $('main');
    main.replaceChildren(el('h1', null, 'Impostazioni'), el('div', 'muted', 'Caricamento…'));
    const [{ settings, opening }] = await Promise.all([rpc('admin_settings'), loadBase()]);
    const I = S.status.integrations;
    const pill = (on, label) => el('span', `pill ${on ? 'ok' : 'off'}`, `${label}: ${on ? 'attivo' : 'non configurato'}`);
    const linkIn = el('input', { type: 'text', id: 'set-link', value: (S.status.public_url || appRoot()).replace(/\/$/, '') + '/', readonly: true, style: 'flex:1' });
    const copy = el('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(linkIn.value); toast('Link copiato'); } catch { linkIn.select(); } } }, 'Copia');

    // regole
    const num = (id, v) => el('input', { type: 'number', id, value: v, min: 0, max: 365, style: 'width:100px' });
    const sH = num('set-h', settings.horizon_days), sC = num('set-c', settings.cancel_hours), sM = num('set-m', settings.max_active_per_student), sR = num('set-r', settings.reminder_hours);
    const sA = el('input', { type: 'number', id: 'set-a', value: settings.cal_alarm_minutes ?? 120, min: 0, max: 2880, style: 'width:100px' });
    const sL = el('input', { type: 'text', id: 'set-l', value: settings.lesson_label });
    const sN = el('input', { type: 'text', id: 'set-n', value: settings.school_name || '' });
    const sP = el('input', { type: 'tel', id: 'set-p', value: settings.school_phone || '' });
    const sAd = el('input', { type: 'text', id: 'set-ad', value: settings.school_address || '', placeholder: 'Via, numero, CAP, città' });
    const sU = el('input', { type: 'text', id: 'set-u', value: settings.public_url || appRoot(), placeholder: 'https://prenota.scuola.it' });
    const sW = el('input', { type: 'tel', id: 'set-w', value: settings.whatsapp_number || '', placeholder: '+39 333 0000000' });
    const sPp = el('input', { type: 'number', id: 'set-pp', value: settings.points_per_lesson ?? 10, min: 0, max: 1000, style: 'width:100px' });
    const sPr = el('input', { type: 'number', id: 'set-pr', value: settings.points_reward ?? 100, min: 1, max: 10000, style: 'width:100px' });
    const sPl = el('input', { type: 'text', id: 'set-pl', value: settings.points_reward_label || '', placeholder: 'Lezione omaggio' });
    const sMp = el('input', { type: 'text', id: 'set-mp', value: settings.member_prefix || 'GS', maxlength: 6, style: 'width:100px' });
    const sSe = el('input', { type: 'text', id: 'set-se', value: settings.season_end || '08-31', placeholder: '08-31', style: 'width:100px' });
    const rulesErr = el('div', 'err');
    // apertura
    const openRows = [1, 2, 3, 4, 5, 6, 0].map((w) => {
      const o = opening.find((x) => x.weekday === w) || { weekday: w };
      const on = el('input', { type: 'checkbox', id: `op-on-${w}`, checked: o.start_hour != null });
      const a = hourSelect(`op-a-${w}`, o.start_hour ?? 15), z = hourSelect(`op-z-${w}`, o.end_hour ?? 22);
      const sync = () => { a.disabled = z.disabled = !on.checked; }; on.onchange = sync; sync();
      return { w, on, a, z, row: el('div', 'shift', el('label', { class: 'check', style: 'width:130px' }, on, cap(DOWL[w])), a, '–', z) };
    });

    const saveRules = el('button', { class: 'btn primary', type: 'button' }, 'Salva regole e orari');
    saveRules.onclick = async () => {
      rulesErr.textContent = '';
      try {
        await rpc('admin_save_settings', {
          p_settings: { horizon_days: sH.value, cancel_hours: sC.value, max_active_per_student: sM.value, reminder_hours: sR.value, cal_alarm_minutes: sA.value, lesson_label: sL.value,
            school_name: sN.value, school_phone: sP.value, school_address: sAd.value, public_url: sU.value, whatsapp_number: sW.value,
            points_per_lesson: sPp.value, points_reward: sPr.value, points_reward_label: sPl.value, member_prefix: sMp.value, season_end: sSe.value },
          p_opening: openRows.map((r) => ({ weekday: r.w, start_hour: r.on.checked ? Number(r.a.value) : null, end_hour: r.on.checked ? Number(r.z.value) : null })),
        });
        await loadBase();
        toast('Impostazioni salvate');
      } catch (e) { rulesErr.textContent = e.message; }
    };

    // sale
    const roomsBox = el('div', { style: 'display:flex;flex-direction:column;gap:8px' });
    const renderRooms = () => roomsBox.replaceChildren(...S.rooms.map((r) => {
      const n = el('input', { type: 'text', id: `rm-n-${r.id}`, value: r.name, style: 'width:140px' });
      const i = el('input', { type: 'text', id: `rm-i-${r.id}`, value: r.info, style: 'flex:1;min-width:160px' });
      const act = el('input', { type: 'checkbox', id: `rm-a-${r.id}`, checked: !!r.active });
      return el('div', 'shift', n, i, el('label', 'check', act, 'Attiva'),
        el('button', { class: 'btn', type: 'button', onclick: async () => { try { await rpc('admin_save_room', { p_id: r.id, p_name: n.value, p_info: i.value, p_active: act.checked }); await loadBase(); toast('Sala salvata'); } catch (e) { toast(e.message); } } }, 'Salva'));
    }));
    renderRooms();
    const addRoom = el('button', { class: 'btn', type: 'button', onclick: async () => { await rpc('admin_save_room', { p_id: null, p_name: `Sala ${S.rooms.length + 1}`, p_info: '' }); await loadBase(); renderRooms(); } }, '+ Aggiungi sala');

    // insegnanti
    const tBox = el('div', 'teacher-card');
    const teacherEditor = (t) => {
      const n = el('input', { type: 'text', id: `tc-n-${t.id || 'new'}`, value: t.name || '', placeholder: 'Nome' });
      const st = el('input', { type: 'text', id: `tc-s-${t.id || 'new'}`, value: t.style || '', placeholder: 'Stile (es. Danza classica)' });
      const col = el('input', { type: 'color', id: `tc-c-${t.id || 'new'}`, value: t.color || '#6F5FCB', style: 'width:44px;height:34px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--surface)' });
      const ph = el('input', { type: 'tel', id: `tc-p-${t.id || 'new'}`, value: t.phone || '', placeholder: 'Telefono (facoltativo)' });
      const act = el('input', { type: 'checkbox', id: `tc-a-${t.id || 'new'}`, checked: t.active !== 0 });
      const shifts = (t.shifts || []).map((s) => ({ ...s }));
      const sBox = el('div', 'shifts');
      const renderShifts = () => sBox.replaceChildren(...shifts.map((s, idx) => {
        const day = el('select', { 'aria-label': 'Giorno' }, ...[1, 2, 3, 4, 5, 6, 0].map((w) => el('option', { value: w, selected: w === s.weekday }, cap(DOWL[w]))));
        const a = hourSelect(`sh-a-${t.id}-${idx}`, s.start_hour), z = hourSelect(`sh-z-${t.id}-${idx}`, s.end_hour);
        day.onchange = () => (s.weekday = Number(day.value)); a.onchange = () => (s.start_hour = Number(a.value)); z.onchange = () => (s.end_hour = Number(z.value));
        return el('div', 'shift', day, a, '–', z, el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Rimuovi turno', onclick: () => { shifts.splice(idx, 1); renderShifts(); } }, '×'));
      }), el('button', { class: 'btn', type: 'button', style: 'align-self:flex-start', onclick: () => { shifts.push({ weekday: 1, start_hour: 15, end_hour: 20 }); renderShifts(); } }, '+ Turno'));
      renderShifts();
      const save = el('button', { class: 'btn primary', type: 'button' }, t.id ? 'Salva' : 'Aggiungi insegnante');
      save.onclick = async () => {
        const body = { name: n.value, style: st.value, color: col.value, phone: ph.value, active: act.checked, shifts };
        try { await rpc('admin_save_teacher', P({ id: t.id ?? null, ...body })); await loadBase(); renderTeachers(); toast('Insegnante salvato'); }
        catch (e) { toast(e.message); }
      };
      const access = !t.id ? null : el('div', 'shift',
        el('span', 'label', 'Accesso all\'agenda'),
        t.login_email ? el('span', 'pill ok', t.login_email) : el('span', 'muted small', 'nessuno'),
        el('button', { class: 'btn', type: 'button', onclick: () => accessForm({ role: 'teacher', teacher: t, after: async () => { await loadBase(); renderTeachers(); } }) }, t.login_email ? 'Nuova password' : 'Crea accesso'),
        t.login_email ? confirmBtn('Togli accesso', 'Conferma', async () => { await rpc('admin_unlink_teacher', { p_teacher_id: t.id }); await loadBase(); renderTeachers(); toast('Accesso tolto'); }) : null);
      return el('div', 'card', el('div', 'shift', col, n, st, ph, el('label', 'check', act, 'Attivo')), el('div', 'label', 'Turni settimanali'), sBox, access, el('div', 'row', save));
    };
    const renderTeachers = () => tBox.replaceChildren(...S.teachers.map(teacherEditor),
      el('details', null, el('summary', { class: 'btn', style: 'display:inline-flex' }, '+ Nuovo insegnante'), el('div', { style: 'margin-top:8px' }, teacherEditor({ shifts: [] }))));
    renderTeachers();

    main.replaceChildren(
      el('h1', null, 'Impostazioni'),
      el('div', 'card', el('h2', null, 'App per gli allievi'),
        el('div', 'muted small', 'Condividi questo link con gli allievi (anche come QR in bacheca). Dal telefono possono aggiungerla alla schermata Home.'),
        el('div', 'shift', linkIn, copy)),
      el('div', 'card', el('h2', null, 'Integrazioni'),
        el('div', 'toolbar', pill(I.google, 'Google Calendar'), pill(I.outlook, 'Outlook'), pill(I.whatsapp, 'WhatsApp notifiche'), pill(I.bot, 'WhatsApp bot')),
        el('div', 'muted small', 'Si attivano inserendo le credenziali nei segreti delle Edge Functions su Supabase (vedi istruzioni).'),
        el('div', 'muted small', S.status.worker_last_run ? `Ultima esecuzione del servizio notifiche: ${S.status.worker_last_run}` : 'Il servizio notifiche non è ancora partito: controlla la configurazione di pg_cron e dei segreti in Vault.'),
        S.status.sync_errors ? el('div', 'err', `${S.status.sync_errors} prenotazioni future non sono state copiate sul calendario: il sistema riprova da solo.`) : null,
        S.status.outbox_failed ? el('div', 'err', `${S.status.outbox_failed} notifiche non sono partite dopo vari tentativi: controlla i log della funzione "worker" su Supabase.`) : null),
      el('div', 'card', el('h2', null, 'Scuola'),
        el('div', 'fields', field('Nome della scuola', sN), field('Telefono segreteria', sP), field('Indirizzo della scuola (va nei calendari)', sAd), field('Indirizzo dell\'app', sU), field('Numero WhatsApp della scuola', sW)),
        el('div', 'muted small', 'Nome e telefono compaiono nell\'app e nei messaggi del bot. L\'indirizzo dell\'app viene mandato dal bot a chi chiede di prenotare. Si salvano con il pulsante qui sotto.')),
      el('div', 'card', el('h2', null, 'Regole di prenotazione'),
        el('div', 'fields', field('Giorni di anticipo massimo', sH), field('Annullamento libero fino a (ore prima)', sC), field('Lezioni future per allievo (max)', sM), field('Promemoria WhatsApp (ore prima)', sR), field('Avviso nel calendario (minuti prima)', sA)),
        field('Nome della lezione', sL),
        el('div', 'label', 'Tessere e punti fedeltà'),
        el('div', 'fields', field('Punti per lezione svolta', sPp), field('Punti per il premio', sPr), field('Premio', sPl), field('Prefisso n. tessera', sMp), field('Fine stagione (mese-giorno)', sSe)),
        el('div', 'label', 'Orari di apertura'), ...openRows.map((r) => r.row), rulesErr, el('div', 'row', saveRules)),
      el('div', 'card', el('h2', null, 'Sale'), roomsBox, el('div', null, addRoom)),
      staffCard(),
      el('h2', null, 'Insegnanti'), tBox);
  }

  boot().catch(() => showLogin());
})();
