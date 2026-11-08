// App allievi: prenotazione lezioni individuali per sala e insegnante.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const pad = (n) => String(n).padStart(2, '0');
  const DOW = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
  const DOWL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const MON = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const monday = (k) => { const d = parse(k); return addDays(k, -((d.getDay() + 6) % 7)); };
  const fmtDay = (k) => { const d = parse(k); return `${DOWL[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  const S = { cfg: null, me: null, week: null, sel: null, filter: null, day: null, weekSum: [], mine: { upcoming: [], past: [] }, tab: 'prenota' };
  const T = () => Object.fromEntries(S.cfg.teachers.map((t) => [t.id, t]));
  const R = () => Object.fromEntries(S.cfg.rooms.map((r) => [r.id, r]));

  // ---------------- Supabase ----------------
  const C = window.SCUOLA_CONFIG || {};
  const sb = window.supabase.createClient(C.supabaseUrl, C.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'prenota-sessione' },
  });
  /** Chiama una funzione del database. I messaggi delle regole (codice P0001) arrivano già in italiano. */
  async function rpc(fn, args = {}) {
    const { data, error } = await sb.rpc(fn, args);
    if (error) {
      const e = new Error(error.code === 'P0001' ? error.message : 'Connessione non riuscita. Riprova.');
      e.code = error.code;
      if (error.code === 'PGRST301' || /JWT/.test(error.message || '')) e.auth = true;
      throw e;
    }
    return data;
  }
  /** 333 1234567 → +393331234567 (stessa regola del database) */
  function normPhone(raw) {
    let p = String(raw || '').replace(/[^\d+]/g, '');
    if (p.startsWith('+')) p = p.slice(1); else if (p.startsWith('00')) p = p.slice(2);
    else if (/^3\d{8,9}$/.test(p) || /^0\d{5,10}$/.test(p)) p = '39' + p;
    if (!/^\d{8,15}$/.test(p)) throw new Error('Numero di telefono non valido. Scrivilo con il prefisso, es. +39 333 1234567.');
    return '+' + p;
  }
  function authError(err, fallback) {
    const c = err?.code || err?.error_code || '';
    if (err?.status === 429 || /rate_limit/.test(c)) return 'Attendi qualche secondo prima di richiedere un altro codice.';
    if (/otp_expired|invalid/.test(c) || err?.status === 403) return 'Codice errato o scaduto. Controlla il messaggio e riprova.';
    if (/sms_send_failed|hook/.test(c)) return 'Non riesco a inviarti il codice su WhatsApp. Controlla il numero o riprova tra poco.';
    return fallback;
  }

  let toastT;
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 3800); }

  // ---------------- caricamento ----------------
  async function loadConfig() {
    S.cfg = await rpc('public_config');
    S.me = S.cfg.me;
    document.title = `Prenota · ${S.cfg.school}`;
    $('brand').textContent = S.cfg.school;
    $('subtitle').textContent = `${S.cfg.lesson_label || 'Lezioni individuali'} da 60 minuti · si annulla fino a ${S.cfg.cancel_hours} ore prima`;
  }
  async function loadWeek() { S.weekSum = await rpc('public_week', { p_start: S.week }); }
  async function loadDay() { S.day = await rpc('public_day', { p_date: S.sel }); }
  async function loadMine() {
    if (!S.me) { S.mine = { upcoming: [], past: [] }; return; }
    try { S.mine = await rpc('my_bookings'); }
    catch (e) { if (e.auth) { await sb.auth.signOut().catch(() => {}); S.me = null; S.mine = { upcoming: [], past: [] }; } else throw e; }
  }
  async function refresh({ week = true, day = true, mine = true } = {}) {
    try {
      await Promise.all([week && loadWeek(), day && loadDay(), mine && loadMine()].filter(Boolean));
      renderAll();
    } catch (e) { toast(e.message); }
  }

  // ---------------- render ----------------
  function renderAccount() {
    const b = $('account');
    b.textContent = S.me ? (S.me.name ? S.me.name.split(' ')[0] : 'Profilo') : 'Accedi';
    b.onclick = () => (S.me ? setTab('profilo') : loginFlow());
    const n = S.mine.upcoming.length;
    $('badge').hidden = !n; $('badge').textContent = n;
  }

  function renderTeachers() {
    const box = $('teachers'); box.replaceChildren();
    for (const t of S.cfg.teachers) {
      const b = el('button', 't'); b.type = 'button'; b.style.setProperty('--tc', t.color);
      b.setAttribute('aria-pressed', String(S.filter === t.id));
      const n = el('span', 'n'); n.append(el('i', 'dot'), el('span', null, t.name));
      b.append(n, el('div', 's', t.style));
      b.onclick = () => { S.filter = S.filter === t.id ? null : t.id; renderTeachers(); renderBoard(); };
      box.append(b);
    }
  }

  function renderWeek() {
    const w0 = parse(S.week), w6 = parse(addDays(S.week, 6));
    $('range').textContent = `${w0.getDate()} ${MON[w0.getMonth()]} – ${w6.getDate()} ${MON[w6.getMonth()]}`;
    $('prev').disabled = S.week <= monday(S.cfg.today);
    $('next').disabled = addDays(S.week, 7) > S.cfg.bookable_until;
    const box = $('days'); box.replaceChildren();
    for (let i = 0; i < 7; i++) {
      const k = addDays(S.week, i), d = parse(k);
      const sum = S.weekSum.find((x) => x.date === k);
      const b = el('button', 'day'); b.type = 'button';
      b.setAttribute('aria-pressed', String(k === S.sel));
      b.disabled = k < S.cfg.today || k > S.cfg.bookable_until;
      const sub = !sum ? '' : !sum.open ? 'chiuso' : b.disabled ? '' : sum.free ? `${sum.free} lib.` : 'pieno';
      b.append(el('span', 'dw', DOW[d.getDay()]), el('span', 'dn', String(d.getDate())), el('span', 'df', sub || ' '));
      b.setAttribute('aria-label', `${fmtDay(k)}${sub ? ', ' + sub : ''}`);
      b.onclick = async () => { S.sel = k; renderWeek(); await refresh({ week: false, mine: false }); };
      box.append(b);
    }
  }

  function renderBoard() {
    $('daytitle').textContent = cap(fmtDay(S.sel));
    const box = $('board'); box.replaceChildren();
    const g = S.day;
    if (!g || g.date !== S.sel) { box.append(el('div', 'closed', 'Caricamento…')); return; }
    if (!g.hours.length) { box.append(el('div', 'closed', 'La scuola è chiusa in questo giorno.')); return; }
    const tmap = T();
    const grid = el('div', 'grid'); grid.style.setProperty('--cols', g.rooms.length); grid.append(el('div'));
    for (const r of g.rooms) { const h = el('div', 'colh'); h.append(el('b', null, r.name), el('span', null, r.info)); grid.append(h); }
    for (const h of g.hours) {
      grid.append(el('div', 'time', `${pad(h)}:00`));
      for (const r of g.rooms) {
        const c = g.cells.find((x) => x.hour === h && x.room_id === r.id);
        const b = el('button', 'cell'); b.type = 'button';
        const label = `${r.name}, ore ${pad(h)}:00`;
        if (c.status === 'booked') {
          const t = tmap[c.teacher_id];
          if (c.mine) {
            b.classList.add('mine'); b.append(el('span', 'st', t ? t.name : ''), el('span', 'sm', c.start_min ? `La tua · ${hm(c)}` : 'La tua'));
            b.onclick = () => openMine(c, r, t);
            b.setAttribute('aria-label', `${label}: la tua lezione con ${t ? t.name : ''}`);
          } else {
            b.classList.add('taken'); b.disabled = true; b.append(el('span', 'st', 'Occupata'), el('span', 'sm', t ? t.name : ''));
            b.setAttribute('aria-label', `${label}: occupata`);
            if (S.filter) b.classList.add('dim');
          }
        } else if (c.status === 'blocked') {
          b.classList.add('blocked'); b.disabled = true; b.append(el('span', 'st', c.title || 'Non disponibile'));
          b.setAttribute('aria-label', `${label}: ${c.title || 'non disponibile'}`);
        } else if (c.status === 'free') {
          b.classList.add('free');
          const dots = el('span', 'dots');
          for (const id of c.teachers) { const i = el('i'); i.style.setProperty('--tc', tmap[id]?.color || 'var(--muted)'); dots.append(i); }
          b.append(el('span', 'st', 'Libera'), dots);
          b.setAttribute('aria-label', `${label}: libera, con ${c.teachers.map((id) => tmap[id]?.name).join(', ')}`);
          if (S.filter && !c.teachers.includes(S.filter)) b.classList.add('dim');
          b.onclick = () => openBooking(c, r);
        } else {
          b.classList.add('off'); b.disabled = true; b.append(el('span', 'st', c.status === 'past' ? 'Passata' : '—'));
          b.setAttribute('aria-label', `${label}: non prenotabile`);
        }
        grid.append(b);
      }
    }
    box.append(grid);
  }

  function lessonRow(b, { past = false } = {}) {
    const d = parse(b.date);
    const row = el('div', 'bk' + (past ? ' past' : ''));
    const when = el('div', 'when'); when.append(el('b', null, `${DOW[d.getDay()]} ${d.getDate()}`), el('span', null, `${MON[d.getMonth()]} · ${hm(b)}`));
    const what = el('div', 'what');
    const title = el('b'); const dot = el('i', 'dot'); dot.style.setProperty('--tc', b.teacher_color || 'var(--muted)');
    title.append(dot, `${b.room_name} con ${b.teacher_name}`);
    const extra = [guestNames(b.guests) && `con ${guestNames(b.guests)}`, b.note || b.teacher_style].filter(Boolean).join(' · ');
    what.append(title, el('span', null, b.status === 'annullata' ? 'Annullata' : extra));
    row.append(when, what);
    if (!past) {
      const cal = el('button', 'btn', 'Calendario'); cal.type = 'button'; cal.onclick = () => calendarSheet(b);
      const acts = el('div', 'acts'); acts.append(cal, cancelButton(b)); row.append(acts);
    }
    return row;
  }

  function renderMine() {
    const up = $('upcoming'); up.replaceChildren();
    if (!S.me) {
      const c = el('div', 'empty'); c.append(el('div', null, 'Accedi con il tuo numero di telefono per vedere le tue lezioni.'));
      const b = el('button', 'btn primary', 'Accedi'); b.type = 'button'; b.style.marginTop = '10px'; b.onclick = () => loginFlow();
      c.append(b); up.append(c); $('pastbox').hidden = true; return;
    }
    if (!S.mine.upcoming.length) {
      const c = el('div', 'empty', 'Nessuna lezione in programma.');
      const b = el('button', 'btn primary', 'Prenota una lezione'); b.type = 'button'; b.style.cssText = 'display:block;margin:10px auto 0'; b.onclick = () => setTab('prenota');
      c.append(b); up.append(c);
    }
    for (const b of S.mine.upcoming) up.append(lessonRow(b));
    $('pastbox').hidden = !S.mine.past.length;
    const p = $('past'); p.replaceChildren(); for (const b of S.mine.past) p.append(lessonRow(b, { past: true }));
  }

  function renderProfile() {
    const box = $('profile'); box.replaceChildren();
    if (!S.me) {
      const c = el('div', 'card');
      c.append(el('div', null, 'Accedi con il tuo numero di telefono. Ti mandiamo un codice su WhatsApp.'));
      const b = el('button', 'btn primary block', 'Accedi'); b.type = 'button'; b.onclick = () => loginFlow(); c.append(b);
      box.append(c);
    } else {
      const c = el('form', 'card');
      const f1 = el('div', 'field'); const l1 = el('label', null, 'Nome e cognome'); l1.htmlFor = 'p-name';
      const i1 = el('input'); i1.type = 'text'; i1.id = 'p-name'; i1.autocomplete = 'name'; i1.value = S.me.name || ''; f1.append(l1, i1);
      const f2 = el('div', 'field'); f2.append(el('label', null, 'Telefono'), el('div', 'muted', S.me.phone));
      const fe = el('div', 'field'); const le = el('label', null, 'Email (facoltativa)'); le.htmlFor = 'p-email';
      const ie = el('input'); ie.type = 'email'; ie.id = 'p-email'; ie.autocomplete = 'email'; ie.value = S.me.email || ''; ie.placeholder = 'Per ricevere l\'invito nel calendario';
      fe.append(le, ie);
      const ck = el('label', 'check'); const i3 = el('input'); i3.type = 'checkbox'; i3.id = 'p-wa'; i3.checked = !!S.me.wa_consent;
      ck.append(i3, el('span', null, 'Ricevi conferme, promemoria e avvisi di annullamento su WhatsApp'));
      const err = el('div', 'err');
      const save = el('button', 'btn primary', 'Salva'); save.type = 'submit';
      const out = el('button', 'btn', 'Esci'); out.type = 'button';
      const row = el('div', 'row'); row.append(out, save);
      c.append(f1, f2, fe, ck, err, row);
      c.onsubmit = async (e) => {
        e.preventDefault(); err.textContent = ''; save.disabled = true;
        try {
          const email = ie.value.trim();
          S.me = await rpc('me_update', { p_name: i1.value, p_wa_consent: i3.checked });
          S.me.email = (await rpc('me_save_email', { p_email: email })).email;
          toast('Profilo salvato'); renderAccount();
        }
        catch (x) { err.textContent = x.message; } finally { save.disabled = false; }
      };
      out.onclick = async () => { await sb.auth.signOut().catch(() => {}); S.me = null; S.mine = { upcoming: [], past: [] }; await refresh(); setTab('prenota'); toast('Sei uscito'); };
      box.append(c);
    }
    const ct = $('contact'); ct.replaceChildren();
    const lines = [];
    const waNum = String(S.cfg.whatsapp_number || '').replace(/\D/g, '');
    if (S.cfg.whatsapp_bot && waNum) lines.push(['Prenota anche su WhatsApp', `Scrivi alla scuola, ad esempio: "lezione con ${S.cfg.teachers[0]?.name || 'un insegnante'} sabato mattina".`, `https://wa.me/${waNum}`, 'Apri WhatsApp']);
    if (S.cfg.school_phone) lines.push(['Segreteria', S.cfg.school_phone, `tel:${S.cfg.school_phone.replace(/\s/g, '')}`, 'Chiama']);
    ct.hidden = !lines.length;
    for (const [t, d, href, btn] of lines) {
      const w = el('div'); w.append(el('b', null, t), el('div', 'muted small', d));
      const a = el('a', 'btn', btn); a.href = href; a.style.cssText = 'display:inline-block;margin-top:8px;text-decoration:none'; if (href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener'; }
      w.append(a); ct.append(w);
    }
  }

  function renderAll() { renderAccount(); renderWeek(); renderBoard(); renderMine(); renderProfile(); }

  function setTab(tab) {
    S.tab = tab;
    for (const v of ['prenota', 'lezioni', 'profilo']) $(`view-${v}`).hidden = v !== tab;
    document.querySelectorAll('.tab').forEach((b) => { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    window.scrollTo({ top: 0 });
  }

  // ---------------- fogli ----------------
  const dlg = $('dlg'), sheet = $('sheet');
  let onClose = null;
  function openSheet(nodes, closeCb) {
    sheet.replaceChildren(el('div', 'grab'), ...nodes); onClose = closeCb || null;
    if (!dlg.open) { try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); } }
    const first = sheet.querySelector('input:not([type=radio]):not([type=checkbox]), textarea');
    if (first && !first.value) setTimeout(() => first.focus(), 60);
  }
  function closeSheet() { try { dlg.close(); } catch { dlg.removeAttribute('open'); } }
  dlg.addEventListener('close', () => { const cb = onClose; onClose = null; cb && cb(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeSheet(); });
  const head = (title, meta) => { const h = el('div'); h.append(el('h3', null, title)); if (meta) h.append(el('div', 'meta', meta)); return h; };

  /** Accesso: telefono → codice → (nome al primo accesso). Risolve true se l'utente ha completato. */
  function loginFlow() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      stepPhone();

      function stepPhone() {
        const form = el('form'); form.style.cssText = 'display:flex;flex-direction:column;gap:14px';
        const f = el('div', 'field'); const l = el('label', null, 'Numero di cellulare'); l.htmlFor = 'l-phone';
        const i = el('input'); i.type = 'tel'; i.id = 'l-phone'; i.autocomplete = 'tel'; i.placeholder = '+39 333 123 4567'; i.required = true; f.append(l, i);
        const err = el('div', 'err');
        const b = el('button', 'btn primary block', 'Inviami il codice'); b.type = 'submit';
        form.append(f, el('div', 'muted small', 'Ti mandiamo un codice di 6 cifre su WhatsApp.'), err, b);
        form.onsubmit = async (e) => {
          e.preventDefault(); err.textContent = ''; b.disabled = true; b.textContent = 'Invio…';
          try {
            const phone = normPhone(i.value);
            const { error } = await sb.auth.signInWithOtp({ phone });
            if (error) throw new Error(authError(error, 'Invio del codice non riuscito. Riprova tra poco.'));
            stepCode(phone);
          } catch (x) { err.textContent = x.message; b.disabled = false; b.textContent = 'Inviami il codice'; }
        };
        openSheet([head('Accedi', 'Per prenotare serve solo il numero di telefono.'), form], () => finish(false));
      }
      function stepCode(phone) {
        const form = el('form'); form.style.cssText = 'display:flex;flex-direction:column;gap:14px';
        const f = el('div', 'field'); const l = el('label', null, `Codice inviato su WhatsApp a ${phone}`); l.htmlFor = 'l-code';
        const i = el('input'); i.id = 'l-code'; i.className = 'code'; i.inputMode = 'numeric'; i.autocomplete = 'one-time-code'; i.maxLength = 6; i.pattern = '\\d{6}'; i.required = true;
        f.append(l, i);
        const err = el('div', 'err');
        const b = el('button', 'btn primary block', 'Conferma'); b.type = 'submit';
        const back = el('button', 'btn block', 'Cambia numero'); back.type = 'button'; back.onclick = () => { onClose = null; stepPhone(); };
        form.append(f, err, b, back);
        i.oninput = () => { i.value = i.value.replace(/\D/g, '').slice(0, 6); if (i.value.length === 6) form.requestSubmit(); };
        form.onsubmit = async (e) => {
          e.preventDefault(); if (b.disabled) return; err.textContent = ''; b.disabled = true;
          try {
            const { error } = await sb.auth.verifyOtp({ phone, token: i.value, type: 'sms' });
            if (error) throw new Error(authError(error, 'Codice errato o scaduto. Controlla il messaggio e riprova.'));
            S.me = await rpc('me_update');            // collega il numero al profilo allievo
            S.cfg = await rpc('public_config');
            if (!S.me.name) stepName(); else { onClose = null; closeSheet(); await afterLogin(); finish(true); }
          } catch (x) { err.textContent = x.message; b.disabled = false; i.select(); }
        };
        onClose = null;
        openSheet([head('Inserisci il codice'), form], () => finish(false));
      }
      function stepName() {
        const form = el('form'); form.style.cssText = 'display:flex;flex-direction:column;gap:14px';
        const f = el('div', 'field'); const l = el('label', null, 'Nome e cognome'); l.htmlFor = 'l-name';
        const i = el('input'); i.type = 'text'; i.id = 'l-name'; i.autocomplete = 'name'; i.required = true; f.append(l, i);
        const ck = el('label', 'check'); const c = el('input'); c.type = 'checkbox'; c.id = 'l-wa'; c.checked = true;
        ck.append(c, el('span', null, 'Ricevi conferme, promemoria e avvisi di annullamento su WhatsApp. Puoi cambiare idea dal profilo.'));
        const err = el('div', 'err');
        const b = el('button', 'btn primary block', 'Continua'); b.type = 'submit';
        form.append(f, ck, err, b);
        form.onsubmit = async (e) => {
          e.preventDefault(); err.textContent = ''; b.disabled = true;
          try { S.me = await rpc('me_update', { p_name: i.value, p_wa_consent: c.checked }); onClose = null; closeSheet(); await afterLogin(); finish(true); }
          catch (x) { err.textContent = x.message; b.disabled = false; }
        };
        onClose = null;
        openSheet([head('Benvenuto', 'Come ti chiami? Lo vedranno la segreteria e il tuo insegnante.'), form], () => finish(false));
      }
    });
  }
  async function afterLogin() { await refresh(); toast(`Ciao ${S.me?.name?.split(' ')[0] || ''}!`.replace(' !', '!')); }

  async function openBooking(cell, room) {
    if (!S.me) { const ok = await loginFlow(); if (!ok) return; const c = S.day.cells.find((x) => x.hour === cell.hour && x.room_id === room.id); if (!c || c.status !== 'free') { toast('Nel frattempo questa sala è stata prenotata. Scegline un\'altra.'); return; } cell = c; }
    const tmap = T();
    const opts = el('div', 'opts');
    const pick = S.filter && cell.teachers.includes(S.filter) ? S.filter : cell.teachers[0];
    for (const id of cell.teachers) {
      const t = tmap[id]; const o = el('label', 'opt');
      const r = el('input'); r.type = 'radio'; r.name = 'inst'; r.value = id; r.id = `inst-${id}`; r.checked = id === pick;
      const dot = el('i', 'dot'); dot.style.setProperty('--tc', t.color);
      const n = el('span'); n.append(el('b', null, t.name), document.createTextNode(` · ${t.style}`));
      o.append(r, dot, n); opts.append(o);
    }
    // partecipante (lezione di coppia) ed eventuale email per l'invito
    const pf = el('details', 'partner');
    const ps = el('summary', null, '+ Partecipa anche un\'altra persona'); pf.append(ps);
    const pn = el('input'); pn.type = 'text'; pn.id = 'b-gname'; pn.placeholder = 'Nome'; pn.autocomplete = 'off'; pn.setAttribute('aria-label', 'Nome del partecipante');
    const pe = el('input'); pe.type = 'email'; pe.id = 'b-gemail'; pe.placeholder = 'Email (riceve l\'invito)'; pe.autocomplete = 'off'; pe.setAttribute('aria-label', 'Email del partecipante');
    const pw = el('div', 'pair'); pw.append(pn, pe); pf.append(pw);
    let myEmail = null;
    if (!S.me?.email) {
      myEmail = el('input'); myEmail.type = 'email'; myEmail.id = 'b-myemail'; myEmail.autocomplete = 'email'; myEmail.placeholder = 'tu@esempio.it';
    }
    const nf = el('div', 'field'); const nl = el('label', null, 'Nota per l\'insegnante (facoltativa)'); nl.htmlFor = 'b-note';
    const ta = el('textarea'); ta.id = 'b-note'; ta.maxLength = 200; ta.placeholder = 'Es. livello principiante, coreografia per il saggio…'; nf.append(nl, ta);
    const err = el('div', 'err');
    const b = el('button', 'btn primary block', 'Conferma prenotazione'); b.type = 'button';
    b.onclick = async () => {
      const sel = sheet.querySelector('input[name="inst"]:checked'); if (!sel) { err.textContent = 'Scegli un insegnante.'; return; }
      b.disabled = true; b.textContent = 'Prenotazione…'; err.textContent = '';
      try {
        if (pe.value.trim() && !pn.value.trim()) throw new Error('Scrivi il nome di chi partecipa.');
        if (myEmail && myEmail.value.trim()) S.me.email = (await rpc('me_save_email', { p_email: myEmail.value })).email;
        const r = await rpc('book', { p_date: S.sel, p_hour: cell.hour, p_room_id: room.id, p_teacher_id: Number(sel.value), p_note: ta.value.trim() });
        let guests = [];
        if (pn.value.trim()) {
          try { guests = await rpc('set_booking_guests', { p_id: r.id, p_guests: [{ name: pn.value, email: pe.value }] }); }
          catch (x) { toast(`Lezione prenotata, ma il partecipante non è stato salvato: ${x.message}`); }
        }
        await refresh();
        const t = T()[Number(sel.value)];
        bookedSheet({ id: r.id, date: r.date, hour: r.hour, room_name: r.room, teacher_name: r.teacher, teacher_style: t?.style, guests, note: ta.value.trim() });
      } catch (x) { err.textContent = x.message; b.disabled = false; b.textContent = 'Conferma prenotazione'; refresh({ mine: false }); }
    };
    openSheet([
      head(`${room.name} · ${pad(cell.hour)}:00`, `${cap(fmtDay(S.sel))} · ${pad(cell.hour)}:00–${pad(cell.hour + 1)}:00 · ${room.info}`),
      el('div', 'label', 'Con chi vuoi fare lezione?'), opts, pf,
      ...(myEmail ? [(() => { const f = el('div', 'field'); const l = el('label', null, 'La tua email, per ricevere la lezione nel calendario (facoltativa)'); l.htmlFor = 'b-myemail'; f.append(l, myEmail); return f; })()] : []),
      nf, err, b,
      el('div', 'muted small', `Puoi annullare dall'app fino a ${S.cfg.cancel_hours} ore prima.${S.me?.wa_consent && S.cfg.whatsapp ? ' Riceverai la conferma su WhatsApp.' : ''}`),
    ]);
  }

  function openMine(cell, room, t) {
    const dl = el('div', 'card'); dl.style.padding = '12px';
    dl.append(el('div', null, `Insegnante: ${t ? `${t.name} · ${t.style}` : '—'}`));
    if (guestNames(cell.guests)) dl.append(el('div', null, `Partecipa anche: ${guestNames(cell.guests)}`));
    if (cell.note) dl.append(el('div', 'muted small', `Nota: ${cell.note}`));
    const b = { id: cell.booking_id, date: S.sel, hour: cell.hour, start_min: cell.start_min || 0, room_name: room.name, teacher_name: t?.name || '', teacher_style: t?.style, guests: cell.guests, note: cell.note };
    const row = el('div', 'row'); const close = el('button', 'btn', 'Chiudi'); close.type = 'button'; close.onclick = closeSheet;
    const cal = el('button', 'btn', 'Calendario'); cal.type = 'button'; cal.onclick = () => calendarSheet(b);
    row.append(cancelButton(b, closeSheet), cal, close);
    openSheet([head(`${room.name} · ${hm(cell)}`, `${cap(fmtDay(S.sel))} · la tua lezione`), dl, row]);
  }

  /** ora di inizio (o di fine, +1 ora) con i minuti: le lezioni possono iniziare per es. alle 18:30 */
  const hm = (b, plus = 0) => `${pad(b.hour + plus)}:${pad(b.start_min || 0)}`;
  const guestNames = (g) => (g || []).map((x) => x.name).filter(Boolean).join(', ');

  // ---------------- calendario personale ----------------
  const ROME_TZ = ['BEGIN:VTIMEZONE', 'TZID:Europe/Rome', 'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
    'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100', 'TZNAME:CET', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD', 'END:VTIMEZONE'];
  function lessonText(b) {
    const title = `${S.cfg.lesson_label || 'Lezione'} con ${b.teacher_name} · ${S.cfg.school}`;
    const details = [`${b.room_name} · ${hm(b)}–${hm(b, 1)}`, guestNames(b.guests) && `Partecipa anche: ${guestNames(b.guests)}`, b.note && `Nota: ${b.note}`].filter(Boolean).join('\n');
    return { title, details, location: `${S.cfg.school} — ${b.room_name}` };
  }
  /** File .ics con l'avviso prima della lezione (lo leggono Outlook, Google, iPhone e Android). */
  function icsFor(b) {
    const tz = S.cfg.timezone || 'Europe/Rome', d = b.date.replace(/-/g, ''), alarm = Number(S.cfg.cal_alarm_minutes ?? 120);
    const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const x = lessonText(b);
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Prenota//Lezioni//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      ...(tz === 'Europe/Rome' ? ROME_TZ : []),
      'BEGIN:VEVENT', `UID:lezione-${b.id}@prenota`, `DTSTAMP:${now}`,
      `DTSTART;TZID=${tz}:${d}T${pad(b.hour)}${pad(b.start_min || 0)}00`, `DTEND;TZID=${tz}:${d}T${pad(b.hour + 1)}${pad(b.start_min || 0)}00`,
      `SUMMARY:${esc(x.title)}`, `LOCATION:${esc(x.location)}`, `DESCRIPTION:${esc(x.details)}`,
      ...(alarm > 0 ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(x.title)}`, `TRIGGER:-PT${alarm}M`, 'END:VALARM'] : []),
      'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  }
  function downloadIcs(b) {
    const ics = icsFor(b), name = `lezione-${b.date}-${pad(b.hour)}${pad(b.start_min || 0)}.ics`;
    if (/iphone|ipad|ipod/i.test(navigator.userAgent)) { location.href = 'data:text/calendar;charset=utf-8,' + encodeURIComponent(ics); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' })); a.download = name;
    document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function calLinks(b) {
    const x = lessonText(b), [y, m, d] = b.date.split('-').map(Number);
    const s0 = new Date(y, m - 1, d, b.hour, b.start_min || 0), s1 = new Date(y, m - 1, d, b.hour + 1, b.start_min || 0);
    const g = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
    const google = 'https://calendar.google.com/calendar/render?' + new URLSearchParams({ action: 'TEMPLATE', text: x.title, dates: `${g(s0)}/${g(s1)}`, ctz: S.cfg.timezone || 'Europe/Rome', details: x.details, location: x.location });
    const outlook = 'https://outlook.office.com/calendar/0/deeplink/compose?' + new URLSearchParams({ subject: x.title, startdt: s0.toISOString(), enddt: s1.toISOString(), location: x.location, body: x.details, path: '/calendar/action/compose', rru: 'addevent' });
    return { google, outlook };
  }
  function calendarSheet(b, title = 'Aggiungi al calendario') {
    const alarm = Number(S.cfg.cal_alarm_minutes ?? 120);
    const when = alarm >= 60 && alarm % 60 === 0 ? `${alarm / 60} ${alarm === 60 ? 'ora' : 'ore'}` : `${alarm} minuti`;
    const links = calLinks(b);
    // link HTTPS al file .ics: funziona anche su iPhone e dall'app installata; senza token si genera il file nel browser
    const token = b.ics_token || S.mine.upcoming.find((x) => x.id === b.id)?.ics_token;
    let ics;
    if (token) {
      ics = el('a', 'btn primary block', 'Calendario del telefono o Outlook (con avviso)');
      ics.href = `${C.supabaseUrl}/functions/v1/ics?b=${b.id}&t=${token}`; ics.target = '_blank'; ics.rel = 'noopener';
    } else { ics = el('button', 'btn primary block', 'Calendario del telefono o Outlook (con avviso)'); ics.type = 'button'; ics.onclick = () => downloadIcs(b); }
    const mk = (href, txt) => { const a = el('a', 'btn block', txt); a.href = href; a.target = '_blank'; a.rel = 'noopener'; return a; };
    const close = el('button', 'btn block', 'Chiudi'); close.type = 'button'; close.onclick = closeSheet;
    const x = lessonText(b);
    openSheet([head(title, `${cap(fmtDay(b.date))} · ${x.details.split('\n')[0]}`),
      ...(guestNames(b.guests) ? [el('div', null, `Partecipa anche: ${guestNames(b.guests)}`)] : []),
      ics, el('div', 'muted small', alarm > 0 ? `Il calendario ti avvisa ${when} prima.` : ''),
      mk(links.google, 'Google Calendar'), mk(links.outlook, 'Outlook sul web'), close]);
  }
  function bookedSheet(b) { calendarSheet(b, 'Prenotato!'); }

  function cancelButton(b, after) {
    const btn = el('button', 'btn danger', 'Annulla'); btn.type = 'button'; let armed = false, timer;
    btn.onclick = async () => {
      if (!armed) { armed = true; btn.textContent = 'Conferma annullamento'; btn.classList.add('sure'); timer = setTimeout(() => { armed = false; btn.textContent = 'Annulla'; btn.classList.remove('sure'); }, 4000); return; }
      clearTimeout(timer); btn.disabled = true; btn.textContent = '…';
      try { await rpc('cancel_my_booking', { p_id: b.id }); toast(`Lezione di ${fmtDay(b.date)} alle ${hm(b)} annullata`); after && after(); await refresh(); }
      catch (x) { toast(x.message); btn.disabled = false; armed = false; btn.textContent = 'Annulla'; btn.classList.remove('sure'); }
    };
    return btn;
  }

  // ---------------- installazione ----------------
  let deferred = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const dismissed = (() => { try { return localStorage.getItem('install-dismissed') === '1'; } catch { return false; } })();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferred = e; if (standalone || dismissed) return;
    $('install').hidden = false; $('install-btn').hidden = false;
  });
  $('install-btn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('install').hidden = true; };
  if (!standalone && !dismissed && /iphone|ipad|ipod/i.test(navigator.userAgent)) {
    $('install').hidden = false; $('install-text').textContent = 'Per averla come app: tocca Condividi e poi “Aggiungi alla schermata Home”.';
    const x = el('button', 'btn', 'Ok'); x.type = 'button'; x.onclick = () => { $('install').hidden = true; try { localStorage.setItem('install-dismissed', '1'); } catch {} };
    $('install').append(x);
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  // ---------------- avvio ----------------
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  $('prev').onclick = async () => { S.week = addDays(S.week, -7); S.sel = firstOpenDay(); renderWeek(); await refresh({ mine: false }); };
  $('next').onclick = async () => { S.week = addDays(S.week, 7); S.sel = firstOpenDay(); renderWeek(); await refresh({ mine: false }); };
  function firstOpenDay() {
    for (let i = 0; i < 7; i++) { const k = addDays(S.week, i); if (k >= S.cfg.today && k <= S.cfg.bookable_until && parse(k).getDay() !== 0) return k; }
    return S.week < S.cfg.today ? S.cfg.today : S.week;
  }

  (async () => {
    try {
      await loadConfig();
      S.sel = S.cfg.today; S.week = monday(S.sel);
      renderTeachers(); renderAll();
      await refresh();
      // Se oggi non ci sono più ore libere, passa al primo giorno con disponibilità
      const today = S.weekSum.find((d) => d.date === S.sel);
      if (today && !today.free) {
        for (let i = 1; i < 14; i++) {
          const k = addDays(S.cfg.today, i); if (k > S.cfg.bookable_until) break;
          if (k >= addDays(S.week, 7)) { S.week = monday(k); await loadWeek(); }
          const d = S.weekSum.find((x) => x.date === k);
          if (d && d.free) { S.sel = k; break; }
        }
        await refresh({ mine: false });
      }
      if (location.hash === '#lezioni' || location.hash === '#profilo') setTab(location.hash.slice(1));
    } catch (e) { $('board').replaceChildren(el('div', 'closed', 'Non riesco a caricare gli orari. Controlla la connessione e riprova.')); }
  })();

  // aggiornamento automatico quando si torna sull'app
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.cfg && !dlg.open) refresh(); });
  setInterval(() => { if (!document.hidden && S.cfg && !dlg.open) refresh({ mine: false }); }, 60_000);
})();
