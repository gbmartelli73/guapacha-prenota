// Pannello amministratore: utenze (amministratori, segreteria, insegnanti, allievi) e insights dell'app.
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
  const NS = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs = {}, ...kids) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); e.append(...kids); return e; }
  const pad = (n) => String(n).padStart(2, '0');
  const MON = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const DOWS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  const parse = (k) => { const [y, m, d] = String(k).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtD = (k) => { if (!k) return '—'; const d = parse(k); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtShort = (k) => { const d = parse(k); return `${d.getDate()} ${MON[d.getMonth()]}`; };
  const fmtDT = (t) => { if (!t) return 'mai'; const d = new Date(t); return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const nf = new Intl.NumberFormat('it-IT');
  const N = (n) => nf.format(n ?? 0);
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const phone = (p) => (p ? '+' + String(p).replace(/^\+/, '') : '');
  const USER_DOMAIN = 'guapacha.invalid';
  const loginEmail = (u) => { const v = u.trim().toLowerCase(); return v.includes('@') ? v : `${v}@${USER_DOMAIN}`; };
  const shownLogin = (e) => (e ? e.replace('@' + USER_DOMAIN, '') : '');
  const DOWL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const hourSelect = (id, val, from = 6, to = 24) => { const s = el('select', { id }); for (let h = from; h <= to; h++) s.append(el('option', { value: h, selected: h === val }, `${pad(h)}:00`)); return s; };
  const ROLE = { admin: 'Amministratore', segreteria: 'Segreteria', insegnante: 'Insegnante', allievo: 'Allievo', nessuno: 'Senza ruolo' };

  const S = { me: null, view: 'insights', days: 30, data: null, users: null, tab: 'tutte', q: '' };

  // ---------------- Supabase ----------------
  const C = window.SCUOLA_CONFIG || {};
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'admin-sessione' },
  });
  async function rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      if (error.code === 'PGRST301' || /JWT/.test(error.message || '')) { showLogin('Sessione scaduta: accedi di nuovo.'); throw new Error('Sessione scaduta: accedi di nuovo.'); }
      if (error.code === 'P0001' && /nuova password/.test(error.message)) { showPw(); }
      throw new Error(error.code === 'P0001' ? error.message : 'Operazione non riuscita. Controlla la connessione e riprova.');
    }
    return data;
  }
  /** Edge Function "amministrazione": crea e gestisce gli account (serve il service role, quindi passa dal server). */
  async function admin(body) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) { showLogin('Sessione scaduta: accedi di nuovo.'); throw new Error('Sessione scaduta.'); }
    let res;
    try {
      res = await fetch(`${C.supabaseUrl}/functions/v1/amministrazione`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}`, apikey: C.supabaseAnonKey },
        body: JSON.stringify(body),
      });
    } catch { throw new Error('Connessione non riuscita. Riprova.'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || 'Operazione non riuscita. Riprova.');
    return j;
  }

  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3800); }
  const dlg = $('dlg'), sheet = $('sheet');
  function openSheet(...nodes) { sheet.replaceChildren(...nodes.filter((n) => n != null && n !== false)); if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } } }
  function closeSheet() { try { dlg.close(); } catch { dlg.removeAttribute('open'); } }
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });
  const field = (label, input, hint) => el('div', 'field', el('label', { for: input.id }, label), input, hint ? el('span', 'muted small', hint) : null);
  function confirmBtn(label, sureLabel, action, cls = 'btn danger') {
    const b = el('button', { class: cls, type: 'button', text: label }); let armed = false, t;
    b.onclick = async () => {
      if (!armed) { armed = true; b.textContent = sureLabel; b.classList.add('sure'); t = setTimeout(() => { armed = false; b.textContent = label; b.classList.remove('sure'); }, 4000); return; }
      clearTimeout(t); b.disabled = true;
      try { await action(); } catch (e) { toast(e.message); b.disabled = false; armed = false; b.textContent = label; b.classList.remove('sure'); }
    };
    return b;
  }

  // ---------------- tooltip dei grafici ----------------
  const tip = $('tip');
  function bindTip(node, html) {
    const show = (e) => { tip.replaceChildren(...html()); tip.hidden = false; move(e); };
    const move = (e) => {
      const x = (e.touches?.[0]?.clientX ?? e.clientX), y = (e.touches?.[0]?.clientY ?? e.clientY);
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.max(8, Math.min(innerWidth - r.width - 8, x + 12)) + 'px';
      tip.style.top = Math.max(8, y - r.height - 12) + 'px';
    };
    node.addEventListener('pointerenter', show); node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', () => (tip.hidden = true));
    node.addEventListener('focus', (e) => { const r = node.getBoundingClientRect(); show({ clientX: r.left + r.width / 2, clientY: r.top }); });
    node.addEventListener('blur', () => (tip.hidden = true));
  }
  addEventListener('scroll', () => (tip.hidden = true), { passive: true });

  // ---------------- accesso ----------------
  const views = ['login', 'pwchange', 'app'];
  const only = (id) => { for (const v of views) $(v).hidden = v !== id; };
  function showLogin(msg = '') { only('login'); closeSheet(); $('lg-err').textContent = msg; $('lg-pass').value = ''; $('lg-user').focus(); }
  function showPw() { only('pwchange'); closeSheet(); $('pw-err').textContent = ''; $('pw-new').value = ''; $('pw-new2').value = ''; $('pw-new').focus(); }

  $('login-form').onsubmit = async (e) => {
    e.preventDefault(); const b = e.submitter; $('lg-err').textContent = ''; b.disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({ email: loginEmail($('lg-user').value), password: $('lg-pass').value });
      if (error) throw new Error(/invalid|credentials/i.test(error.message) ? 'Nome utente o password non corretti.' : /banned/i.test(error.message) ? 'Questo account è sospeso.' : 'Accesso non riuscito. Riprova.');
      await boot();
    } catch (x) { $('lg-err').textContent = x.message; }
    b.disabled = false;
  };
  $('pw-form').onsubmit = async (e) => {
    e.preventDefault(); const b = e.submitter; $('pw-err').textContent = '';
    const p1 = $('pw-new').value, p2 = $('pw-new2').value;
    if (p1 !== p2) { $('pw-err').textContent = 'Le due password non coincidono.'; return; }
    if (p1.length < 8) { $('pw-err').textContent = 'La password deve avere almeno 8 caratteri.'; return; }
    b.disabled = true;
    try {
      await admin({ action: 'cambia_password', password: p1 });
      const { data: { session } } = await sb.auth.getSession();
      await sb.auth.signInWithPassword({ email: session.user.email, password: p1 });
      toast('Password aggiornata'); await boot();
    } catch (x) { $('pw-err').textContent = x.message; }
    b.disabled = false;
  };
  const logout = async () => { await sb.auth.signOut().catch(() => {}); S.me = null; showLogin(); };
  $('logout').onclick = logout; $('logout2').onclick = logout; $('pw-logout').onclick = logout;
  $('mypw').onclick = () => myPassword();

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return showLogin();
    try { S.me = await rpc('sa_me'); } catch (x) { return showLogin(x.message); }
    if (!S.me.admin) { await sb.auth.signOut(); return showLogin('Questo account non è un amministratore. La segreteria accede da "Apri la segreteria".'); }
    if (S.me.must_change_password) return showPw();
    only('app');
    $('who').textContent = `Accesso: ${shownLogin(S.me.email)}`;
    $('brand').firstChild.textContent = S.me.school || 'Guapacha Studio';
    route();
  }

  // ---------------- navigazione ----------------
  document.querySelectorAll('.nav[data-view]').forEach((b) => (b.onclick = () => { location.hash = b.dataset.view; }));
  addEventListener('hashchange', () => S.me && route());
  function route() {
    const v = location.hash.slice(1) || 'insights';
    S.view = ['insights', 'utenze', 'sale', 'insegnanti', 'disponibilita'].includes(v) ? v : 'insights';
    document.querySelectorAll('.nav[data-view]').forEach((b) => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
    tip.hidden = true;
    ({ utenze: viewUsers, sale: viewRooms, insegnanti: viewTeachers, disponibilita: viewAvailability }[S.view] || viewInsights)();
  }
  const main = $('main');
  const loading = (t) => main.replaceChildren(el('div', 'toolbar', el('h1', null, t)), el('p', 'muted', 'Carico…'));

  // ================================================================ INSIGHTS
  async function viewInsights() {
    if (!S.data || S.data.period.days !== S.days) loading('Insights');
    try { S.data = await rpc('sa_insights', { p_days: S.days }); } catch (x) { main.replaceChildren(el('h1', null, 'Insights'), el('p', 'err', x.message)); return; }
    renderInsights();
  }

  function deltaEl(cur, prev, { goodUp = true, unit = '' } = {}) {
    if (prev == null) return null;
    const d = cur - prev;
    if (!d) return el('span', 'delta', `= come il periodo prima`);
    const good = goodUp ? d > 0 : d < 0;
    return el('span', `delta ${good ? 'good' : 'bad'}`, `${d > 0 ? '▲' : '▼'} ${d > 0 ? '+' : ''}${N(d)}${unit} rispetto al periodo prima`);
  }
  const kpi = (label, value, suffix, sub, delta) =>
    el('div', 'kpi', el('span', 'k-label', label), el('span', 'k-val', value, suffix ? el('small', null, suffix) : null), delta, sub ? el('span', 'k-sub', sub) : null);

  /** Barre verticali (una serie): etichette ogni n, tooltip su tutta la colonna, tabella dati per l'accessibilità. */
  function barChart(rows, { height = 170, fmt = N, title = '' } = {}) {
    const W = 640, H = height, L = 30, B = 22, T = 10;
    const max = Math.max(1, ...rows.map((r) => r.value));
    const nice = max <= 4 ? max : Math.ceil(max / 4) * 4;
    const cw = (W - L) / rows.length, bw = Math.max(4, Math.min(34, cw * 0.62));
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
    for (const f of [0.5, 1]) {
      const y = T + (H - T - B) * (1 - f);
      s.append(svg('line', { class: 'grid', x1: L, x2: W, y1: y, y2: y }), svg('text', { x: L - 6, y: y + 4, 'text-anchor': 'end' }, fmt(Math.round(nice * f))));
    }
    const every = Math.ceil(rows.length / 8);
    rows.forEach((r, i) => {
      const x = L + i * cw, h = (H - T - B) * (r.value / nice), y = H - B - h;
      const g = svg('g', { class: 'col', tabindex: 0 });
      g.append(svg('rect', { class: 'hl', x, y: T, width: cw, height: H - T - B, fill: 'transparent' }));
      if (r.value > 0) {
        const bx = x + (cw - bw) / 2, rr = Math.min(4, bw / 2, h);
        g.append(svg('path', { class: `bar${r.dim ? ' dim' : ''}`, d: `M${bx},${H - B} V${y + rr} Q${bx},${y} ${bx + rr},${y} H${bx + bw - rr} Q${bx + bw},${y} ${bx + bw},${y + rr} V${H - B} Z` }));
      }
      if (i % every === 0 || i === rows.length - 1) g.append(svg('text', { x: x + cw / 2, y: H - 6, 'text-anchor': 'middle' }, r.label));
      bindTip(g, () => [el('b', null, r.tipTitle || r.label), el('span', null, r.tip || fmt(r.value))]);
      s.append(g);
    });
    s.append(svg('line', { class: 'axis', x1: L, x2: W, y1: H - B, y2: H - B }));
    const t = el('table', null, el('thead', null, el('tr', null, el('th', null, 'Periodo'), el('th', null, 'Valore'))),
      el('tbody', null, rows.map((r) => el('tr', null, el('td', null, r.tipTitle || r.label), el('td', 'num', fmt(r.value))))));
    return el('div', null, el('div', 'chart', s), el('details', 'data', el('summary', null, 'Vedi i dati in tabella'), el('div', 'table-wrap', t)));
  }

  /** Barre orizzontali con valore scritto accanto (niente colore come unica informazione). */
  function hbars(rows, { max } = {}) {
    const m = max ?? Math.max(1, ...rows.map((r) => r.value));
    return el('div', 'hbars', rows.map((r) => {
      const row = el('div', 'hbar', el('span', 'lbl', r.label), el('div', 'track', el('div', { class: 'fill', style: `width:${Math.max(0, Math.min(100, (r.value / m) * 100))}%` })), el('span', 'val', r.text ?? N(r.value)));
      if (r.tip) bindTip(row, () => [el('b', null, r.label), el('span', null, r.tip)]);
      return row;
    }));
  }

  function heatmap(cells) {
    const by = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.n]));
    const hours = cells.length ? [...new Set(cells.map((c) => c.hour))] : [];
    const lo = Math.min(9, ...hours), hi = Math.max(21, ...hours);
    const H = []; for (let h = lo; h <= hi; h++) H.push(h);
    const max = Math.max(1, ...cells.map((c) => c.n));
    const g = el('div', { class: 'heat', style: `grid-template-columns:auto repeat(${H.length},minmax(0,1fr))` });
    g.append(el('span'), ...H.map((h) => el('span', 'hd', (h - lo) % 2 === 0 ? pad(h) : '')));
    for (const d of [1, 2, 3, 4, 5, 6, 0]) {
      g.append(el('span', 'rl', DOWS[d]));
      for (const h of H) {
        const n = by.get(`${d}-${h}`) || 0;
        const c = el('span', { class: `c${n ? '' : ' z'}`, style: `--v:${(0.18 + 0.82 * (n / max)).toFixed(2)}`, tabindex: n ? 0 : -1, 'aria-label': `${DOWS[d]} ore ${pad(h)}: ${n} lezioni` });
        bindTip(c, () => [el('b', null, `${DOWS[d]} · ${pad(h)}:00`), el('span', null, n ? `${n} ${n === 1 ? 'lezione' : 'lezioni'}` : 'nessuna lezione')]);
        g.append(c);
      }
    }
    return el('div', null, g, el('div', 'heat-legend', el('span', null, 'meno'), el('i'), el('span', null, `più (max ${max})`)));
  }

  function renderInsights() {
    const D = S.data, K = D.kpi;
    const seg = el('div', 'seg', [7, 30, 90, 365].map((d) => el('button', { type: 'button', 'aria-pressed': String(S.days === d), onclick: () => { S.days = d; viewInsights(); } },
      d === 7 ? '7 giorni' : d === 30 ? '30 giorni' : d === 90 ? '3 mesi' : '12 mesi')));
    const head = el('div', 'toolbar', el('h1', null, 'Insights'), el('span', 'grow'), seg,
      el('button', { class: 'btn', type: 'button', onclick: () => viewInsights() }, 'Aggiorna'));
    const period = el('p', 'muted small', `Periodo: dal ${fmtD(D.period.from)} al ${fmtD(D.period.to)} · confronto con i ${D.period.days} giorni precedenti (${fmtShort(D.period.prev_from)} – ${fmtShort(D.period.prev_to)}).`);

    const occ = pct(K.occupancy_booked, K.occupancy_slots);
    const cancRate = pct(K.cancelled, K.lessons + K.cancelled), cancPrev = pct(K.cancelled_prev, K.lessons_prev + K.cancelled_prev);
    const marked = K.present + K.absent;
    const kpis1 = el('div', 'kpis',
      kpi('Lezioni prenotate', N(K.lessons), null, `${N(K.lessons_done)} già svolte · ${N(K.upcoming_7)} nei prossimi 7 giorni`, deltaEl(K.lessons, K.lessons_prev)),
      kpi('Allievi attivi', N(K.students_active), null, 'con almeno una lezione nel periodo', deltaEl(K.students_active, K.students_active_prev)),
      kpi('Nuovi allievi', N(K.students_new), null, `${N(K.students_total)} allievi in totale`, deltaEl(K.students_new, K.students_new_prev)),
      kpi('Occupazione sale', N(occ), '%', `${N(K.occupancy_booked)} ore prenotate su ${N(K.occupancy_slots)} disponibili`),
      kpi('Annullamenti', N(cancRate), '%', `${N(K.cancelled)} lezioni annullate`, deltaEl(cancRate, cancPrev, { goodUp: false, unit: ' punti' })),
      kpi('Assenze', marked ? N(pct(K.absent, marked)) : '—', marked ? '%' : null, marked ? `${N(K.absent)} assenti su ${N(marked)} presenze segnate` : 'nessuna presenza segnata nel periodo'));
    const kpis2 = el('div', 'kpis',
      kpi('Allievi con l\'app', N(K.students_app), null, `${pct(K.students_app, K.students_total)}% degli allievi`),
      kpi('Consenso WhatsApp', N(K.wa_consent), null, `${pct(K.wa_consent, K.students_total)}% degli allievi`),
      kpi('Notifiche attive', N(K.push_students), null, 'allievi con le notifiche sul telefono'),
      kpi('Conferme di presenza', K.lessons ? N(pct(K.confirmed_by_student, K.lessons)) : '—', K.lessons ? '%' : null, `${N(K.confirmed_by_student)} lezioni confermate dall'allievo`),
      kpi('Anticipo medio', K.lead_hours == null ? '—' : K.lead_hours >= 48 ? N(Math.round(K.lead_hours / 24)) : N(Math.round(K.lead_hours)), K.lead_hours == null ? null : K.lead_hours >= 48 ? 'giorni' : 'ore', 'tra la prenotazione e la lezione'),
      kpi('Punti fedeltà', N(K.points_awarded), 'pt', `${N(K.rewards_redeemed)} premi riscattati`));

    // andamento settimanale
    const wk = D.weekly || [];
    const weekly = el('div', 'card', el('h2', null, 'Lezioni per settimana', el('small', null, 'ultime 12 settimane')),
      barChart(wk.map((w, i) => ({ label: fmtShort(w.week), value: w.lessons, dim: i === wk.length - 1, tipTitle: `Settimana dal ${fmtShort(w.week)}`, tip: `${N(w.lessons)} lezioni · ${N(w.cancelled)} annullate${i === wk.length - 1 ? ' (settimana in corso)' : ''}` })), { title: 'Lezioni per settimana' }));
    const newSt = el('div', 'card', el('h2', null, 'Nuovi allievi per settimana', el('small', null, 'ultime 12 settimane')),
      barChart(wk.map((w) => ({ label: fmtShort(w.week), value: w.new_students, tipTitle: `Settimana dal ${fmtShort(w.week)}`, tip: `${N(w.new_students)} nuovi allievi` })), { title: 'Nuovi allievi per settimana', height: 150 }));

    const heat = el('div', 'card', el('h2', null, 'Quando si balla', el('small', null, 'lezioni per giorno e ora')),
      D.heatmap.length ? heatmap(D.heatmap) : el('p', 'muted', 'Ancora nessuna lezione nel periodo.'));

    const rooms = el('div', 'card', el('h2', null, 'Occupazione per sala'),
      D.rooms.length ? hbars(D.rooms.map((r) => ({ label: r.name, value: pct(r.booked, r.slots), text: `${pct(r.booked, r.slots)}% · ${N(r.lessons)} lez.`, tip: `${N(r.booked)} ore prenotate su ${N(r.slots)} disponibili` })), { max: 100 }) : el('p', 'muted', 'Nessuna sala attiva.'));

    const tt = el('table', null, el('thead', null, el('tr', null, ['Insegnante', 'Lezioni', 'Allievi', 'Ore di turno', 'Occupazione', 'Annullate'].map((h) => el('th', null, h)))),
      el('tbody', null, D.teachers.map((t) => el('tr', null, el('td', null, el('b', null, t.name), el('div', 'muted small', t.style || '')),
        el('td', 'num', N(t.lessons)), el('td', 'num', N(t.students)), el('td', 'num', N(t.shift_hours)),
        el('td', 'num', t.shift_hours ? `${pct(t.lessons, t.shift_hours)}%` : '—'), el('td', 'num', N(t.cancelled))))));
    const teachers = el('div', 'card', el('h2', null, 'Insegnanti', el('small', null, 'occupazione = lezioni / ore di turno')), el('div', 'table-wrap', tt));

    const SRCN = { app: 'App', segreteria: 'Segreteria', whatsapp: 'WhatsApp' };
    const srcRows = Object.entries(D.sources).map(([k, v]) => ({ label: SRCN[k] || k, value: v }));
    const BYN = { allievo: 'Dall\'allievo', segreteria: 'Dalla segreteria', whatsapp: 'Da WhatsApp', 'n.d.': 'Non indicato' };
    const byRows = Object.entries(D.cancelled_by).map(([k, v]) => ({ label: BYN[k] || k, value: v }));
    const channels = el('div', 'card', el('h2', null, 'Da dove arrivano le prenotazioni'),
      srcRows.length ? hbars(srcRows.map((r) => ({ ...r, text: `${N(r.value)} · ${pct(r.value, K.lessons)}%` }))) : el('p', 'muted', 'Nessuna prenotazione nel periodo.'),
      el('h2', { style: 'margin-top:6px' }, 'Chi annulla'),
      byRows.length ? hbars(byRows) : el('p', 'muted', 'Nessun annullamento nel periodo.'));

    const W = D.waitlist;
    const wait = el('div', 'card', el('h2', null, 'Lista d\'attesa', el('small', null, `${N(W.open)} richieste aperte ora`)),
      W.total ? hbars([
        { label: 'Richieste', value: W.total },
        { label: 'Avvisati', value: W.notified, text: `${N(W.notified)} · ${pct(W.notified, W.total)}%` },
        { label: 'Hanno prenotato', value: W.booked, text: `${N(W.booked)} · ${pct(W.booked, W.total)}%` },
        { label: 'Usciti dalla lista', value: W.left },
      ], { max: W.total }) : el('p', 'muted', 'Nessuna richiesta di lista d\'attesa nel periodo.'));

    const M = D.members;
    const members = el('div', 'card', el('h2', null, 'Tessere'),
      el('div', 'stats', [['Valide', M.active], ['In scadenza (30 gg)', M.expiring_30], ['Scadute', M.expired], ['Da attivare', M.none]].map(([l, v]) => el('div', 'stat', el('b', null, N(v)), el('span', null, l)))),
      el('div', 'muted small', `Certificato medico: ${N(M.medical_expiring_30)} in scadenza nei prossimi 30 giorni, ${N(M.medical_expired)} scaduti.`),
      M.expiring_list.length ? el('div', 'table-wrap', el('table', null, el('thead', null, el('tr', null, el('th', null, 'Allievo'), el('th', null, 'Tessera'), el('th', null, 'Scade'))),
        el('tbody', null, M.expiring_list.map((s) => el('tr', null, el('td', null, s.name || '—'), el('td', 'num', s.member_no || ''), el('td', 'num', fmtD(s.until))))))) : null);

    const top = el('div', 'card', el('h2', null, 'Allievi più presenti', el('small', null, 'nel periodo')),
      D.top_students.length ? el('div', 'table-wrap', el('table', null, el('thead', null, el('tr', null, el('th', null, 'Allievo'), el('th', null, 'Lezioni'), el('th', null, 'Annullate'))),
        el('tbody', null, D.top_students.map((s) => el('tr', null, el('td', null, s.name || '—', el('div', 'muted small', s.member_no || '')), el('td', 'num', N(s.lessons)), el('td', 'num', N(s.cancelled))))))) : el('p', 'muted', 'Nessuna lezione nel periodo.'));

    const A = D.accounts, Y = D.system;
    const status = (ok, warn, text) => el('span', `status ${ok ? 'ok' : warn ? 'warn' : 'bad'}`, ok ? '● ' : warn ? '▲ ' : '✕ ', text);
    const sys = el('div', 'card', el('h2', null, 'Utenze e sistema'),
      el('div', 'stats', [['Amministratori', A.admin], ['Segreteria', A.segreteria], ['Insegnanti con accesso', A.insegnanti], ['Allievi con l\'app', A.allievi], ['Accessi nel periodo', A.signed_in_period]].map(([l, v]) => el('div', 'stat', el('b', null, N(v)), el('span', null, l)))),
      el('div', { style: 'display:flex;flex-direction:column;gap:6px' },
        status(!Y.outbox_errors && !Y.msg_errors && !(Y.outbox_pending + Y.msg_pending), !Y.outbox_errors && !Y.msg_errors, Y.outbox_errors || Y.msg_errors
          ? `${N(Y.outbox_errors + Y.msg_errors)} invii in errore (WhatsApp / calendari / notifiche)` : Y.outbox_pending + Y.msg_pending
          ? `${N(Y.outbox_pending + Y.msg_pending)} invii in attesa (WhatsApp o calendari non ancora collegati)` : 'Nessun invio in sospeso'),
        status(!Y.calendar_errors, false, Y.calendar_errors ? `${N(Y.calendar_errors)} lezioni future non sincronizzate con il calendario` : 'Calendari: nessun errore'),
        status(Y.push_devices > 0, true, `${N(Y.push_devices)} telefoni con le notifiche · ultima ricevuta: ${fmtDT(Y.push_last_received)}`),
        Y.last_error ? el('div', 'note', `Ultimo errore: ${Y.last_error}`) : null));

    main.replaceChildren(head, period, kpis1, kpis2, el('div', 'grid2', weekly, newSt), el('div', 'grid2', heat, rooms), teachers,
      el('div', 'grid2', channels, wait), el('div', 'grid2', members, top), sys);
  }

  // ================================================================ UTENZE
  async function viewUsers() {
    if (!S.users) loading('Utenze');
    try { S.users = await rpc('sa_users'); } catch (x) { main.replaceChildren(el('h1', null, 'Utenze'), el('p', 'err', x.message)); return; }
    renderUsers();
  }

  function renderUsers() {
    const U = S.users;
    const acc = U.accounts.filter((a) => a.role !== 'allievo');
    const count = { tutte: acc.length + U.students.length, admin: 0, segreteria: 0, insegnante: 0, allievo: U.students.length };
    for (const a of acc) if (count[a.role] != null) count[a.role]++;
    const tabs = el('div', 'tabs', [['tutte', 'Tutte'], ['admin', 'Amministratori'], ['segreteria', 'Segreteria'], ['insegnante', 'Insegnanti'], ['allievo', 'Allievi']].map(([k, l]) =>
      el('button', { type: 'button', 'aria-pressed': String(S.tab === k), onclick: () => { S.tab = k; renderUsers(); } }, l, el('span', null, count[k]))));
    const search = el('input', { type: 'search', id: 'u-q', placeholder: 'Cerca nome, email, telefono, tessera…', value: S.q, style: 'min-width:240px' });
    search.oninput = () => { S.q = search.value; const pos = search.selectionStart; renderUsers(); const s2 = $('u-q'); s2.focus(); s2.setSelectionRange(pos, pos); };
    const head = el('div', 'toolbar', el('h1', null, 'Utenze'), el('span', 'grow'),
      el('button', { class: 'btn primary', type: 'button', onclick: () => newUser() }, '+ Nuova utenza'));

    const q = S.q.trim().toLowerCase();
    const match = (...xs) => !q || xs.some((x) => String(x ?? '').toLowerCase().includes(q));
    const rows = [];
    if (S.tab !== 'allievo') for (const a of acc) {
      if (S.tab !== 'tutte' && a.role !== S.tab) continue;
      if (!match(a.name, a.email, a.phone, ROLE[a.role])) continue;
      rows.push(accountRow(a));
    }
    if (S.tab === 'tutte' || S.tab === 'allievo') for (const s of U.students) {
      if (!match(s.name, s.phone, s.email, s.login_email, s.member_no)) continue;
      rows.push(studentRow(s));
    }
    const table = el('div', 'table-wrap', el('table', null,
      el('thead', null, el('tr', null, ['Nome', 'Accesso', 'Ruolo', 'Ultimo accesso', 'Stato', ''].map((h) => el('th', null, h)))),
      el('tbody', null, rows.length ? rows : el('tr', null, el('td', { colspan: 6, class: 'muted' }, 'Nessuna utenza trovata.')))));
    const note = el('div', 'note', 'Gli allievi entrano nell\'app con il numero di cellulare (codice via SMS/WhatsApp). Se dai a un allievo email e password, può entrare anche con quelle. Eliminare un account toglie solo l\'accesso: anagrafica, tessera e lezioni restano.');
    main.replaceChildren(head, el('div', 'toolbar', tabs, el('span', 'grow'), search), table, note);
  }

  const stateCell = (banned, never) => banned ? el('span', 'pill bad', 'Sospeso') : never ? el('span', 'pill off', 'Mai entrato') : el('span', 'pill ok', 'Attivo');
  function accountRow(a) {
    const acts = el('div', 'acts', el('button', { class: 'btn', type: 'button', onclick: () => manage(a) }, 'Gestisci'));
    return el('tr', null,
      el('td', null, el('b', null, a.name || shownLogin(a.email) || phone(a.phone)), a.me ? el('div', 'muted small', 'sei tu') : null, a.must_change_password ? el('div', 'muted small', 'deve cambiare la password') : null),
      el('td', null, shownLogin(a.email) || phone(a.phone)),
      el('td', null, el('span', `role ${a.role}`, ROLE[a.role])),
      el('td', 'num', fmtDT(a.last_sign_in_at)),
      el('td', null, stateCell(a.banned, !a.last_sign_in_at)),
      el('td', null, acts));
  }
  function studentRow(s) {
    const acts = el('div', 'acts', el('button', { class: 'btn', type: 'button', onclick: () => manageStudent(s) }, 'Gestisci'));
    return el('tr', null,
      el('td', null, el('b', null, s.name || '—'), el('div', 'muted small', [s.member_no, `${N(s.lessons)} lezioni`].filter(Boolean).join(' · '))),
      el('td', null, phone(s.phone), s.login_email ? el('div', 'muted small', s.login_email) : null),
      el('td', null, el('span', 'role allievo', 'Allievo')),
      el('td', 'num', s.user_id ? fmtDT(s.last_sign_in_at) : 'mai'),
      el('td', null, s.user_id ? stateCell(s.banned, !s.last_sign_in_at) : el('span', 'pill off', 'Non ancora entrato')),
      el('td', null, acts));
  }

  // ---------------- nuova utenza ----------------
  function newUser(preset = {}) {
    let role = preset.role || 'allievo';
    const pick = el('div', 'rolepick', [
      ['allievo', 'Allievo', 'entra con il cellulare (e, se vuoi, email e password)'],
      ['segreteria', 'Segreteria', 'agenda, prenotazioni, allievi, impostazioni'],
      ['insegnante', 'Insegnante', 'vede le sue lezioni e conferma'],
      ['admin', 'Amministratore', 'utenze e insights (e segreteria)'],
    ].map(([k, l, d]) => el('button', { type: 'button', 'aria-pressed': String(role === k), onclick: () => { role = k; draw(); } }, el('b', null, l), el('span', null, d))));
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:12px' });
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'submit' }, 'Crea utenza');
    const form = el('form', { style: 'display:flex;flex-direction:column;gap:14px' }, pick, box, err, el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Annulla'), save));
    const genPw = () => { const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const r = crypto.getRandomValues(new Uint32Array(10)); return [...r].map((x) => a[x % a.length]).join(''); };
    const pwInput = (id, required) => {
      const i = el('input', { type: 'text', id, autocomplete: 'off', minlength: 8, required, spellcheck: 'false', placeholder: required ? 'almeno 8 caratteri' : 'facoltativa' });
      const g = el('button', { class: 'btn', type: 'button', onclick: () => { i.value = genPw(); } }, 'Genera');
      return { i, node: el('div', 'field', el('label', { for: id }, 'Password'), el('div', { style: 'display:flex;gap:6px' }, i, g)) };
    };
    function draw() {
      pick.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(['allievo', 'segreteria', 'insegnante', 'admin'][i] === role)));
      box.replaceChildren();
      if (role === 'allievo') {
        const pw = pwInput('n-pw', false);
        box.append(
          field('Nome e cognome', el('input', { type: 'text', id: 'n-name', required: true, autocomplete: 'off', value: preset.name || '' })),
          field('Cellulare', el('input', { type: 'tel', id: 'n-phone', required: true, placeholder: '+39 333 123 4567', value: preset.phone ? phone(preset.phone) : '' })),
          field('Email', el('input', { type: 'email', id: 'n-email', placeholder: 'facoltativa (serve per l\'accesso con password)', value: preset.email || '' })),
          pw.node,
          el('label', 'check', el('input', { type: 'checkbox', id: 'n-wa' }), el('span', null, 'Ha dato il consenso a ricevere messaggi WhatsApp')),
          el('div', 'note', 'Senza password l\'allievo entra nell\'app con il cellulare e il codice. Con email e password può entrare anche con quelle (pulsante "Accedi con email" nell\'app).'));
      } else {
        const pw = pwInput('n-pw', true);
        box.append(
          field('Nome', el('input', { type: 'text', id: 'n-name', autocomplete: 'off', required: role !== 'insegnante', placeholder: role === 'insegnante' ? 'facoltativo' : '' })),
          field('Nome utente o email', el('input', { type: 'text', id: 'n-user', required: true, autocapitalize: 'none', spellcheck: 'false', autocomplete: 'off', placeholder: 'es. laura oppure laura@esempio.it' }),
            'Con un nome utente semplice (senza @) si entra scrivendo solo quello.'),
          pw.node);
        if (role === 'insegnante') {
          const sel = el('select', { id: 'n-teacher' }, el('option', { value: 'new' }, '+ Nuovo insegnante'),
            S.users.teachers.map((t) => el('option', { value: t.id, disabled: !!t.login_email }, `${t.name}${t.style ? ' · ' + t.style : ''}${t.login_email ? ' (ha già un accesso)' : ''}`)));
          const first = preset.teacher_id ? S.users.teachers.find((t) => t.id === preset.teacher_id) : S.users.teachers.find((t) => !t.login_email); if (first) sel.value = String(first.id);
          const nt = el('div', { class: 'fields', id: 'n-newt' },
            field('Nome dell\'insegnante', el('input', { type: 'text', id: 'n-tname' })), field('Stile', el('input', { type: 'text', id: 'n-style', placeholder: 'es. Tango' })));
          const sync = () => (nt.hidden = sel.value !== 'new'); sel.onchange = sync; sync();
          box.append(field('Insegnante', sel, 'Collega l\'accesso a un insegnante già presente nell\'agenda, o creane uno nuovo.'), nt);
        }
        if (role === 'admin') box.append(el('div', 'note', 'Al primo accesso il nuovo amministratore dovrà scegliere una sua password.'));
      }
    }
    form.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = ''; save.disabled = true;
      const v = (id) => ($(id)?.value ?? '').trim();
      const body = { action: 'crea', role, name: v('n-name'), password: v('n-pw') };
      if (role === 'allievo') Object.assign(body, { phone: v('n-phone'), email: v('n-email'), wa_consent: $('n-wa').checked });
      else body.username = v('n-user');
      if (role === 'insegnante') { if (v('n-teacher') === 'new') Object.assign(body, { new_teacher: v('n-tname') || v('n-name'), style: v('n-style') }); else body.teacher_id = Number(v('n-teacher')); }
      try {
        const r = await admin(body);
        S.users = await rpc('sa_users');
        if (preset.after) await preset.after(); else { S.tab = role === 'admin' ? 'admin' : role; S.q = ''; renderUsers(); }
        credentials(role, body, r);
      } catch (x) { err.textContent = x.message; save.disabled = false; }
    };
    draw();
    openSheet(el('h3', null, 'Nuova utenza'), form);
    setTimeout(() => $('n-name')?.focus(), 50);
  }

  /** Riepilogo da consegnare alla persona (copiabile). */
  function credentials(role, body, r) {
    const base = new URL('../', location.href).href;
    const where = role === 'allievo' ? base : role === 'admin' ? location.href.split('#')[0] : new URL('../segreteria/', location.href).href;
    const lines = role === 'allievo'
      ? [`App: ${base}`, `Accesso: con il cellulare ${body.phone} (codice)`, ...(r.login ? [`Oppure email: ${r.login}`, `Password: ${body.password}`] : [])]
      : [`Indirizzo: ${where}`, `Nome utente: ${body.username}`, `Password: ${body.password}`, ...(role === 'admin' ? ['(al primo accesso sceglierà una nuova password)'] : [])];
    const text = lines.join('\n');
    const pre = el('pre', { style: 'white-space:pre-wrap;background:var(--soft);border-radius:10px;padding:12px;margin:0;font-family:var(--f-mono);font-size:13px' }, text);
    const copy = el('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copiato'); } catch { toast('Seleziona il testo e copialo'); } } }, 'Copia');
    openSheet(el('h3', null, 'Utenza creata'), el('p', 'meta', `${ROLE[role]}${body.name ? ': ' + body.name : ''}. Consegna questi dati alla persona (la password non verrà più mostrata).`), pre,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'), copy));
  }

  // ---------------- gestione di un account ----------------
  function manage(a) {
    const pw = el('input', { type: 'text', id: 'm-pw', minlength: 8, placeholder: 'nuova password (min. 8)', autocomplete: 'off', spellcheck: 'false' });
    const err = el('div', 'err');
    const setPw = el('button', { class: 'btn', type: 'button', onclick: async () => {
      err.textContent = ''; setPw.disabled = true;
      try { await admin({ action: 'password', user_id: a.user_id, password: pw.value }); toast('Password cambiata'); credentialsReset(a, pw.value); }
      catch (x) { err.textContent = x.message; setPw.disabled = false; }
    } }, 'Imposta password');
    const suspend = el('button', { class: 'btn', type: 'button', onclick: async () => {
      suspend.disabled = true;
      try { await admin({ action: 'sospendi', user_id: a.user_id, on: !a.banned }); toast(a.banned ? 'Account riattivato' : 'Account sospeso'); closeSheet(); S.users = await rpc('sa_users'); renderUsers(); }
      catch (x) { err.textContent = x.message; suspend.disabled = false; }
    } }, a.banned ? 'Riattiva l\'account' : 'Sospendi l\'account');
    const del = confirmBtn('Elimina l\'account', 'Conferma eliminazione', async () => {
      await admin({ action: 'elimina', user_id: a.user_id }); toast('Account eliminato'); closeSheet(); S.users = await rpc('sa_users'); renderUsers();
    });
    openSheet(el('h3', null, a.name || shownLogin(a.email) || 'Account'),
      el('dl', 'kv', el('dt', null, 'Ruolo'), el('dd', null, ROLE[a.role]), el('dt', null, 'Accesso'), el('dd', null, shownLogin(a.email) || phone(a.phone)),
        el('dt', null, 'Creato'), el('dd', null, fmtDT(a.created_at)), el('dt', null, 'Ultimo accesso'), el('dd', null, fmtDT(a.last_sign_in_at))),
      el('div', 'field', el('label', { for: 'm-pw' }, 'Cambia la password'), el('div', { style: 'display:flex;gap:6px' }, pw, setPw)),
      err,
      a.me ? el('p', 'muted small', 'È il tuo account: per sicurezza non puoi sospenderlo o eliminarlo da qui.') : el('div', { class: 'row', style: 'justify-content:flex-start' }, suspend, del),
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi')));
  }
  function credentialsReset(a, pw) {
    const text = `Nome utente: ${shownLogin(a.email) || phone(a.phone)}\nNuova password: ${pw}`;
    openSheet(el('h3', null, 'Password cambiata'), el('pre', { style: 'white-space:pre-wrap;background:var(--soft);border-radius:10px;padding:12px;margin:0;font-family:var(--f-mono);font-size:13px' }, text),
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi'),
        el('button', { class: 'btn primary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(text); toast('Copiato'); } catch { toast('Seleziona il testo e copialo'); } } }, 'Copia')));
  }
  function manageStudent(s) {
    const sheetUrl = new URL(`../segreteria/#allievi?q=${encodeURIComponent(s.member_no || s.phone)}`, location.href).href;
    const acc = s.user_id ? S.users.accounts.find((a) => a.user_id === s.user_id) : null;
    openSheet(el('h3', null, s.name || 'Allievo'),
      el('dl', 'kv', el('dt', null, 'Cellulare'), el('dd', null, phone(s.phone)), el('dt', null, 'Email'), el('dd', null, s.email || s.login_email || '—'),
        el('dt', null, 'Tessera'), el('dd', null, s.member_no ? `${s.member_no}${s.member_until ? ' · scade il ' + fmtD(s.member_until) : ' · da attivare'}` : '—'),
        el('dt', null, 'Lezioni'), el('dd', null, N(s.lessons)), el('dt', null, 'App'), el('dd', null, s.user_id ? `entrato · ultimo accesso ${fmtDT(s.last_sign_in_at)}` : 'non ancora entrato'),
        el('dt', null, 'Accesso con password'), el('dd', null, s.login_email ? s.login_email : 'no')),
      el('div', { class: 'row', style: 'justify-content:flex-start' },
        el('a', { class: 'btn', href: sheetUrl, target: '_blank', rel: 'noopener' }, 'Apri la scheda in segreteria ↗'),
        el('button', { class: 'btn', type: 'button', onclick: () => newUser({ role: 'allievo', name: s.name, phone: s.phone, email: s.email || s.login_email || '' }) }, s.login_email ? 'Cambia email/password' : 'Dai email e password'),
        acc ? el('button', { class: 'btn', type: 'button', onclick: () => manage(acc) }, 'Sospendi / elimina accesso') : null),
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Chiudi')));
  }

  function myPassword() {
    const a = el('input', { type: 'password', id: 'my-pw', minlength: 8, autocomplete: 'new-password' });
    const b = el('input', { type: 'password', id: 'my-pw2', minlength: 8, autocomplete: 'new-password' });
    const err = el('div', 'err');
    const save = el('button', { class: 'btn primary', type: 'submit' }, 'Salva');
    const form = el('form', { style: 'display:flex;flex-direction:column;gap:12px' }, field('Nuova password', a), field('Ripeti la nuova password', b), err,
      el('div', 'row', el('button', { class: 'btn', type: 'button', onclick: closeSheet }, 'Annulla'), save));
    form.onsubmit = async (e) => {
      e.preventDefault(); err.textContent = '';
      if (a.value !== b.value) { err.textContent = 'Le due password non coincidono.'; return; }
      save.disabled = true;
      try { await admin({ action: 'cambia_password', password: a.value }); closeSheet(); toast('Password aggiornata'); }
      catch (x) { err.textContent = x.message; save.disabled = false; }
    };
    openSheet(el('h3', null, 'Cambia la tua password'), form);
  }

  // ================================================================ SALE E ORARI
  async function viewRooms() {
    loading('Sale e orari');
    let rooms, opening;
    try { [rooms, { opening }] = await Promise.all([rpc('admin_rooms'), rpc('admin_settings')]); }
    catch (x) { main.replaceChildren(el('h1', null, 'Sale e orari'), el('p', 'err', x.message)); return; }
    const list = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
    const roomRow = (r) => {
      const id = r.id || 'new';
      const n = el('input', { type: 'text', id: `rm-n-${id}`, value: r.name || '', placeholder: 'Nome della sala', required: true, style: 'width:170px' });
      const i = el('input', { type: 'text', id: `rm-i-${id}`, value: r.info || '', placeholder: 'Descrizione (es. 80 mq, specchi, parquet)', style: 'flex:1;min-width:200px' });
      const act = el('input', { type: 'checkbox', id: `rm-a-${id}`, checked: r.id ? !!r.active : true });
      const save = el('button', { class: r.id ? 'btn' : 'btn primary', type: 'button' }, r.id ? 'Salva' : 'Aggiungi sala');
      save.onclick = async () => {
        save.disabled = true;
        try { await rpc('admin_save_room', { p_id: r.id ?? null, p_name: n.value, p_info: i.value, p_active: act.checked }); toast(r.id ? 'Sala salvata' : 'Sala aggiunta'); viewRooms(); }
        catch (x) { toast(x.message); save.disabled = false; }
      };
      return el('div', { class: 'shift', style: r.id && !r.active ? 'opacity:.6' : '' }, n, i, r.id ? el('label', 'check', act, 'Attiva') : null, save);
    };
    list.append(...rooms.map(roomRow));
    const roomsCard = el('div', 'card', el('h2', null, 'Sale', el('small', null, `${rooms.filter((r) => r.active).length} attive`)),
      el('div', 'muted small', 'Una sala disattivata sparisce dalle prenotazioni ma resta nello storico. Le lezioni già prenotate non vengono toccate.'),
      list, el('div', 'label', 'Nuova sala'), roomRow({}));

    const openRows = [1, 2, 3, 4, 5, 6, 0].map((w) => {
      const o = opening.find((x) => x.weekday === w) || { weekday: w };
      const on = el('input', { type: 'checkbox', id: `op-on-${w}`, checked: o.start_hour != null });
      const a = hourSelect(`op-a-${w}`, o.start_hour ?? 15), z = hourSelect(`op-z-${w}`, o.end_hour ?? 22);
      const sync = () => { a.disabled = z.disabled = !on.checked; }; on.onchange = sync; sync();
      return { w, on, a, z, row: el('div', 'shift', el('label', { class: 'check', style: 'width:130px' }, on, cap(DOWL[w])), a, '–', z) };
    });
    const err = el('div', 'err');
    const saveOpen = el('button', { class: 'btn primary', type: 'button' }, 'Salva orari');
    saveOpen.onclick = async () => {
      err.textContent = '';
      const bad = openRows.find((r) => r.on.checked && Number(r.z.value) <= Number(r.a.value));
      if (bad) { err.textContent = `${cap(DOWL[bad.w])}: l'ora di chiusura deve essere dopo l'apertura.`; return; }
      saveOpen.disabled = true;
      try {
        await rpc('admin_save_settings', { p_settings: {}, p_opening: openRows.map((r) => ({ weekday: r.w, start_hour: r.on.checked ? Number(r.a.value) : null, end_hour: r.on.checked ? Number(r.z.value) : null })) });
        toast('Orari salvati');
      } catch (x) { err.textContent = x.message; }
      saveOpen.disabled = false;
    };
    const openCard = el('div', 'card', el('h2', null, 'Orari di apertura della scuola'),
      el('div', 'muted small', 'Le sale si possono prenotare solo in questi orari (a ore intere). Chiusure, festività e corsi collettivi si gestiscono in segreteria → Chiusure e corsi.'),
      ...openRows.map((r) => r.row), err, el('div', 'row', saveOpen));
    main.replaceChildren(el('div', 'toolbar', el('h1', null, 'Sale e orari')), roomsCard, openCard);
  }

  // ================================================================ INSEGNANTI
  async function viewTeachers() {
    loading('Insegnanti');
    let teachers;
    try { teachers = await rpc('admin_teachers'); } catch (x) { main.replaceChildren(el('h1', null, 'Insegnanti'), el('p', 'err', x.message)); return; }
    const editor = (t) => {
      const id = t.id || 'new';
      const n = el('input', { type: 'text', id: `tc-n-${id}`, value: t.name || '', placeholder: 'Nome', style: 'width:150px' });
      const st = el('input', { type: 'text', id: `tc-s-${id}`, value: t.style || '', placeholder: 'Stile (es. Tango)', style: 'width:170px' });
      const col = el('input', { type: 'color', id: `tc-c-${id}`, value: t.color || '#6F5FCB', 'aria-label': 'Colore in agenda', style: 'width:44px;height:34px;padding:2px;border:1px solid var(--line);border-radius:8px;background:var(--surface)' });
      const ph = el('input', { type: 'tel', id: `tc-p-${id}`, value: t.phone || '', placeholder: 'Telefono (facoltativo)', style: 'width:170px' });
      const act = el('input', { type: 'checkbox', id: `tc-a-${id}`, checked: t.id ? !!t.active : true });
      const shifts = (t.shifts || []).map((s) => ({ ...s }));
      const sBox = el('div', 'shifts');
      const renderShifts = () => sBox.replaceChildren(...shifts.map((s, idx) => {
        const day = el('select', { 'aria-label': 'Giorno' }, ...[1, 2, 3, 4, 5, 6, 0].map((w) => el('option', { value: w, selected: w === s.weekday }, cap(DOWL[w]))));
        const a = hourSelect(`sh-a-${id}-${idx}`, s.start_hour), z = hourSelect(`sh-z-${id}-${idx}`, s.end_hour);
        day.onchange = () => (s.weekday = Number(day.value)); a.onchange = () => (s.start_hour = Number(a.value)); z.onchange = () => (s.end_hour = Number(z.value));
        return el('div', 'shift', day, a, '–', z, el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Rimuovi turno', onclick: () => { shifts.splice(idx, 1); renderShifts(); } }, '×'));
      }), el('button', { class: 'btn', type: 'button', style: 'align-self:flex-start', onclick: () => { shifts.push({ weekday: 1, start_hour: 15, end_hour: 20 }); renderShifts(); } }, '+ Turno'));
      renderShifts();
      const save = el('button', { class: 'btn primary', type: 'button' }, t.id ? 'Salva' : 'Aggiungi insegnante');
      save.onclick = async () => {
        const bad = shifts.find((s) => s.end_hour <= s.start_hour);
        if (bad) { toast(`Turno di ${DOWL[bad.weekday]}: l'ora di fine deve essere dopo l'inizio.`); return; }
        save.disabled = true;
        try {
          await rpc('admin_save_teacher', { p_id: t.id ?? null, p_name: n.value, p_style: st.value, p_color: col.value, p_phone: ph.value, p_active: act.checked, p_shifts: shifts });
          toast(t.id ? 'Insegnante salvato' : 'Insegnante aggiunto'); viewTeachers();
        } catch (x) { toast(x.message); save.disabled = false; }
      };
      const hours = shifts.reduce((s, x) => s + (x.end_hour - x.start_hour), 0);
      const access = !t.id ? null : el('div', 'shift',
        el('span', 'label', 'Accesso all\'agenda'),
        t.login_email ? el('span', 'pill ok', shownLogin(t.login_email)) : el('span', 'muted small', 'nessuno'),
        t.login_email ? el('a', { class: 'btn', href: '#utenze' }, 'Gestisci in Utenze') : el('button', { class: 'btn', type: 'button', onclick: async () => {
          if (!S.users) S.users = await rpc('sa_users');
          newUser({ role: 'insegnante', teacher_id: t.id, after: async () => { S.users = await rpc('sa_users'); viewTeachers(); } });
        } }, 'Crea accesso'));
      return el('div', { class: 'card', style: t.id && !t.active ? 'opacity:.7' : '' },
        el('div', 'shift', col, n, st, ph, el('label', 'check', act, 'Attivo')),
        el('div', 'label', t.id ? `Turni settimanali · ${hours} ore` : 'Turni settimanali'), sBox, access,
        el('div', 'row', t.id ? el('button', { class: 'btn', type: 'button', onclick: () => { S.availTeacher = t.id; location.hash = 'disponibilita'; } }, 'Assenze e disponibilità extra') : null, save));
    };
    main.replaceChildren(el('div', 'toolbar', el('h1', null, 'Insegnanti'), el('span', 'grow'), el('span', 'muted small', 'Il colore è quello usato in agenda; i turni decidono quando l\'insegnante è prenotabile.')),
      ...teachers.map(editor),
      el('details', null, el('summary', { class: 'btn primary', style: 'display:inline-flex' }, '+ Nuovo insegnante'), el('div', { style: 'margin-top:10px' }, editor({ shifts: [] }))));
  }

  // ================================================================ DISPONIBILITÀ
  async function viewAvailability(teacherId = null) {
    const box = el('div', { style: 'display:flex;flex-direction:column;gap:16px' });
    main.replaceChildren(el('div', 'toolbar', el('h1', null, 'Disponibilità degli insegnanti')), box);
    const ch = await window.Disponibilita.changesCard({ rpc, onOpen: (id) => { S.availTeacher = id; viewAvailability(id); } });
    if (ch) main.insertBefore(ch, box);
    await window.Disponibilita.mount(box, { rpc, toast, teacherId: teacherId ?? S.availTeacher ?? null });
  }

  // ---------------- avvio ----------------
  const ver = $('appver'); if (ver && self.APP_VERSION) ver.textContent = 'Versione ' + self.APP_VERSION;
  if (!C.supabaseUrl) { showLogin('Configurazione mancante (config.js).'); return; }
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') showLogin(); });
  boot();
})();
