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

  const S = { status: null, rooms: [], teachers: [], view: 'agenda', date: null, mode: 'sale', day: null, week: [], list: { q: '' }, students: { q: '' } };

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
      if (error.code === 'P0001' && /riservato alla segreteria/.test(error.message)) { showLogin('Questo account non è abilitato alla segreteria.'); }
      throw new Error(error.code === 'P0001' ? error.message : 'Operazione non riuscita. Controlla la connessione e riprova.');
    }
    return data;
  }
  /** { date, hour } → { p_date, p_hour } per le funzioni del database */
  const P = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => ['p_' + k, v]));
  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3800); }

  const dlg = $('dlg'), sheet = $('sheet');
  function openSheet(...nodes) { sheet.replaceChildren(...nodes); if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } } }
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
    try { await loadBase(); } catch (e) { showLogin(e.message); return; }
    $('login').hidden = true; $('app').hidden = false;
    S.date ||= S.status.today;
    const v = location.hash.slice(1);
    go(['agenda', 'prenotazioni', 'allievi', 'blocchi', 'impostazioni'].includes(v) ? v : 'agenda');
  }

  function go(view) {
    S.view = view; if (location.hash.slice(1) !== view) history.replaceState(null, '', '#' + view);
    document.querySelectorAll('.nav').forEach((b) => { if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    ({ agenda: viewAgenda, prenotazioni: viewList, allievi: viewStudents, blocchi: viewBlocks, impostazioni: viewSettings })[view]();
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
        el('button', { class: 'btn', type: 'button', onclick: () => blockForm({ date: S.date }) }, 'Blocca orario')),
      el('div', { id: 'ag-week', class: 'days' }), el('div', { id: 'ag-stats', class: 'stats' }),
      el('div', { id: 'ag-board', class: 'scroll' }, el('div', 'closedday', 'Caricamento…')),
      el('div', 'legend',
        el('span', null, el('i', { class: 'dot', style: '--tc:var(--ok)' }), 'Libera: clic per prenotare a nome di un allievo'),
        el('span', null, el('i', { class: 'dot', style: '--tc:var(--muted)' }), '— nessun insegnante in turno (clic per forzare)'),
        el('span', null, 'Bordo colorato = insegnante')));
    try {
      const ws = monday(S.date);
      const [day, week] = await Promise.all([rpc('admin_day', { p_date: S.date }), rpc('admin_week', { p_start: ws })]);
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
      if (S.mode === 'sale') grid.append(el('div', 'colh', el('b', null, c.name), el('span', null, c.info)));
      else grid.append(el('div', 'colh', el('b', null, el('i', { class: 'dot', style: `--tc:${c.color}` }), c.name), el('span', null, c.style)));
    }
    for (const h of g.hours) {
      grid.append(el('div', 'time', `${pad(h)}:00`));
      for (const col of cols) grid.append(S.mode === 'sale' ? roomSlot(g, h, col) : teacherSlot(g, h, col));
    }
    board.replaceChildren(grid);
  }

  function bookedSlot(c) {
    const t = teacherById(c.teacher_id), r = roomById(c.room_id);
    const s = el('button', { class: 'slot booked', type: 'button', style: `--tc:${t?.color || 'var(--muted)'}` },
      el('span', 'a', c.student_name || 'Allievo'),
      el('span', 'b', S.mode === 'sale' ? `${t?.name || ''}${c.note ? ' · ' + c.note : ''}` : `${r?.name || ''}${c.note ? ' · ' + c.note : ''}`));
    if (c.sync_error) s.append(el('span', { class: 'flag bad', title: c.sync_error }, '! cal'));
    else if (c.source !== 'app') s.append(el('span', 'flag', c.source === 'whatsapp' ? 'WA' : 'segr.'));
    s.onclick = () => bookingDetails(c);
    return s;
  }
  function roomSlot(g, h, room) {
    const c = g.cells.find((x) => x.hour === h && x.room_id === room.id);
    if (c.status === 'booked') return bookedSlot(c);
    if (c.status === 'blocked') {
      const b = g.blocks.find((x) => x.id === c.block_id);
      return el('button', { class: 'slot blocked', type: 'button', onclick: () => blockDetails(b) }, el('span', 'a', c.title), el('span', 'b', b?.teacher_name || ''));
    }
    if (c.status === 'past') return el('div', 'slot off', el('span', 'a', 'Passata'));
    if (c.status === 'free') {
      const names = c.teachers.map((id) => teacherById(id)?.name).filter(Boolean);
      return el('button', { class: 'slot free', type: 'button', onclick: () => bookingForm({ date: g.date, hour: h, room_id: room.id }) },
        el('span', 'a', 'Libera'), el('span', 'b', names.join(', ')));
    }
    return el('button', { class: 'slot off clickable', type: 'button', title: 'Nessun insegnante in turno', onclick: () => bookingForm({ date: g.date, hour: h, room_id: room.id }) }, el('span', 'a', '—'));
  }
  function teacherSlot(g, h, t) {
    const c = g.cells.find((x) => x.hour === h && x.status === 'booked' && x.teacher_id === t.id);
    if (c) return bookedSlot(c);
    const blk = g.blocks.find((b) => b.teacher_id === t.id && h >= b.start_hour && h < b.end_hour);
    if (blk) return el('button', { class: 'slot blocked', type: 'button', onclick: () => blockDetails(blk) }, el('span', 'a', blk.title), el('span', 'b', blk.room_name || ''));
    const inShift = g.shifts.some((s) => s.teacher_id === t.id && h >= s.start_hour && h < s.end_hour);
    const anyCell = g.cells.find((x) => x.hour === h);
    if (anyCell && anyCell.status === 'past') return el('div', 'slot off', el('span', 'a', inShift ? 'Passata' : '—'));
    const freeRooms = g.cells.filter((x) => x.hour === h && (x.status === 'free' || x.status === 'off')).length;
    if (inShift) return el('button', { class: 'slot free', type: 'button', onclick: () => bookingForm({ date: g.date, hour: h, teacher_id: t.id }) },
      el('span', 'a', 'In turno · libero'), el('span', 'b', `${freeRooms} sale libere`));
    return el('div', 'slot off', el('span', 'a', '—'));
  }

  // ---------- dettaglio e nuova prenotazione ----------
  function bookingDetails(c) {
    const t = teacherById(c.teacher_id), r = roomById(c.room_id);
    const kv = el('dl', 'kv',
      el('dt', null, 'Allievo'), el('dd', null, c.student_name || '—'),
      el('dt', null, 'Telefono'), el('dd', null, el('a', { href: `tel:${phone(c.student_phone)}` }, phone(c.student_phone))),
      el('dt', null, 'Insegnante'), el('dd', null, `${t?.name || ''} · ${t?.style || ''}`),
      el('dt', null, 'Sala'), el('dd', null, r?.name || ''),
      c.note ? el('dt', null, 'Nota') : null, c.note ? el('dd', null, c.note) : null,
      el('dt', null, 'Prenotata da'), el('dd', null, `${SRC[c.source] || c.source} · ${new Date(c.created_at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`),
      c.sync_error ? el('dt', null, 'Calendario') : null, c.sync_error ? el('dd', { style: 'color:var(--danger)' }, c.sync_error) : null);
    const row = el('div', 'row');
    if (c.sync_error) row.append(el('button', { class: 'btn', type: 'button', onclick: async () => { await rpc('admin_resync', { p_id: c.booking_id }); toast('Nuovo tentativo avviato: controlla tra un minuto'); closeSheet(); viewAgenda(); } }, 'Riprova calendario'));
    row.append(confirmBtn('Annulla lezione', 'Conferma annullamento', async () => { await rpc('admin_cancel', { p_id: c.booking_id }); closeSheet(); toast('Lezione annullata. L\'allievo riceve l\'avviso se ha WhatsApp attivo.'); viewAgenda(); }),
      el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'));
    openSheet(el('div', null, el('h3', null, `${r?.name || ''} · ${pad(c.hour)}:00`), el('div', 'meta', cap(fmtDay(S.day.date)))), kv, row);
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
    const lines = rows.map((r) => [r.date.split('-').reverse().join('/'), `${pad(r.hour)}:00`, r.room_name, r.teacher_name, r.student_name,
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
            el('td', 'num', fmtShort(b.date)), el('td', 'num', `${pad(b.hour)}:00`), el('td', null, b.room_name), el('td', null, b.teacher_name),
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
    const q = el('input', { type: 'search', id: 'st-q', placeholder: 'Cerca per nome o telefono', value: S.students.q });
    const body = el('div', null, el('div', 'muted', 'Caricamento…'));
    $('main').replaceChildren(el('div', 'toolbar', el('h1', { class: 'grow' }, 'Allievi'), q), body);
    const load = async () => {
      S.students.q = q.value.trim();
      const rows = await rpc('admin_students', { p_q: S.students.q.replace(/^\+/, '') });
      if (!rows.length) { body.replaceChildren(el('div', 'closedday', S.students.q ? 'Nessun allievo trovato.' : 'Ancora nessun allievo: si registrano da soli al primo accesso all\'app.')); return; }
      const tb = el('tbody');
      for (const s of rows) {
        tb.append(el('tr', { style: 'cursor:pointer', onclick: () => editStudent(s, load) },
          el('td', null, el('b', null, s.name || '(senza nome)')), el('td', 'num', phone(s.phone)), el('td', 'num', s.lessons),
          el('td', 'num', s.last_date ? fmtShort(s.last_date) : '—'),
          el('td', null, s.wa_consent ? el('span', 'pill ok', 'Sì') : el('span', 'pill off', 'No')), el('td', 'muted', s.notes || '')));
      }
      body.replaceChildren(el('div', 'table-wrap', el('table', null, el('thead', null, el('tr', null, ...['Nome', 'Telefono', 'Lezioni', 'Ultima', 'WhatsApp', 'Note'].map((h) => el('th', null, h)))), tb)));
    };
    let t; q.oninput = () => { clearTimeout(t); t = setTimeout(load, 250); };
    load().catch((e) => body.replaceChildren(el('div', 'err', e.message)));
  }
  function editStudent(s, reload) {
    const name = el('input', { type: 'text', id: 'es-name', value: s.name || '' });
    const notes = el('textarea', { id: 'es-notes', maxlength: 500 }); notes.value = s.notes || '';
    const wa = el('input', { type: 'checkbox', id: 'es-wa', checked: !!s.wa_consent });
    const err = el('div', 'err');
    openSheet(el('div', null, el('h3', null, s.name || 'Allievo'), el('div', 'meta', phone(s.phone))),
      field('Nome e cognome', name), field('Note interne (non visibili all\'allievo)', notes),
      el('label', 'check', wa, 'Riceve messaggi WhatsApp (consenso dato)'), err,
      el('div', 'row',
        el('button', { class: 'btn', type: 'button', onclick: () => { closeSheet(); S.list = { q: s.phone, from: addDays(S.status.today, -180), to: addDays(S.status.today, 60) }; go('prenotazioni'); } }, 'Vedi prenotazioni'),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => {
          try { await rpc('admin_update_student', { p_id: s.id, p_name: name.value, p_notes: notes.value, p_wa_consent: wa.checked }); closeSheet(); toast('Allievo aggiornato'); reload(); }
          catch (e) { err.textContent = e.message; }
        } }, 'Salva')));
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
    const sL = el('input', { type: 'text', id: 'set-l', value: settings.lesson_label });
    const sN = el('input', { type: 'text', id: 'set-n', value: settings.school_name || '' });
    const sP = el('input', { type: 'tel', id: 'set-p', value: settings.school_phone || '' });
    const sU = el('input', { type: 'text', id: 'set-u', value: settings.public_url || appRoot(), placeholder: 'https://prenota.scuola.it' });
    const sW = el('input', { type: 'tel', id: 'set-w', value: settings.whatsapp_number || '', placeholder: '+39 333 0000000' });
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
          p_settings: { horizon_days: sH.value, cancel_hours: sC.value, max_active_per_student: sM.value, reminder_hours: sR.value, lesson_label: sL.value,
            school_name: sN.value, school_phone: sP.value, public_url: sU.value, whatsapp_number: sW.value },
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
      return el('div', 'card', el('div', 'shift', col, n, st, ph, el('label', 'check', act, 'Attivo')), el('div', 'label', 'Turni settimanali'), sBox, el('div', 'row', save));
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
        el('div', 'fields', field('Nome della scuola', sN), field('Telefono segreteria', sP), field('Indirizzo dell\'app', sU), field('Numero WhatsApp della scuola', sW)),
        el('div', 'muted small', 'Nome e telefono compaiono nell\'app e nei messaggi del bot. L\'indirizzo dell\'app viene mandato dal bot a chi chiede di prenotare. Si salvano con il pulsante qui sotto.')),
      el('div', 'card', el('h2', null, 'Regole di prenotazione'),
        el('div', 'fields', field('Giorni di anticipo massimo', sH), field('Annullamento libero fino a (ore prima)', sC), field('Lezioni future per allievo (max)', sM), field('Promemoria WhatsApp (ore prima)', sR)),
        field('Nome della lezione', sL),
        el('div', 'label', 'Orari di apertura'), ...openRows.map((r) => r.row), rulesErr, el('div', 'row', saveRules)),
      el('div', 'card', el('h2', null, 'Sale'), roomsBox, el('div', null, addRoom)),
      el('h2', null, 'Insegnanti'), tBox);
  }

  boot().catch(() => showLogin());
})();
