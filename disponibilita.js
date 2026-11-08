// Disponibilità degli insegnanti: turni settimanali, assenze (date bloccate) e disponibilità extra.
// Usato dalla segreteria (tutti gli insegnanti), dagli insegnanti (solo sé stessi) e dal pannello amministratore.
(() => {
  'use strict';
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
  const DOWL = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
  const MON = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const parse = (k) => { const [y, m, d] = String(k).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (k, n) => { const d = parse(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const fmtDay = (k) => { const d = parse(k); return `${cap(DOWL[d.getDay()])} ${d.getDate()} ${MON[d.getMonth()]}`; };
  const hours = (a, z) => (a === 0 && z === 24 ? 'tutto il giorno' : `${pad(a)}:00–${pad(z)}:00`);
  const hourSelect = (id, val, from = 6, to = 24) => { const s = el('select', { id }); for (let h = from; h <= to; h++) s.append(el('option', { value: h, selected: h === val }, `${pad(h)}:00`)); return s; };
  const field = (label, input) => el('div', 'field', el('label', { for: input.id }, label), input);
  const lessonText = (c) => `${fmtDay(c.date)} ${pad(c.hour)}:${pad(c.start_min || 0)}${c.room ? ' · ' + c.room : ''}${c.student ? ' · ' + c.student : ''}`;

  /** Raggruppa le assenze di giorni consecutivi con stessa fascia e motivo: "dal 3 al 7 dic". */
  function groupBlocks(list) {
    const out = [];
    for (const b of list) {
      const last = out[out.length - 1];
      if (last && last.start_hour === b.start_hour && last.end_hour === b.end_hour && last.title === b.title && addDays(last.to, 1) === b.date) {
        last.to = b.date; last.ids.push(b.id); last.lessons += b.lessons;
      } else out.push({ ...b, from: b.date, to: b.date, ids: [b.id] });
    }
    return out;
  }

  async function mount(root, { rpc, toast, teacherId = null, intro = true }) {
    let D;
    let tid = teacherId;
    async function load() {
      root.replaceChildren(el('p', 'muted', 'Carico…'));
      try { D = await rpc('avail_get', { p_teacher_id: tid, p_days: 120 }); }
      catch (x) { root.replaceChildren(el('p', 'err', x.message)); return; }
      tid = D.teacher.id;
      render();
    }

    function render() {
      const t = D.teacher;
      const head = el('div', 'toolbar',
        D.staff ? el('select', { id: 'av-teacher', 'aria-label': 'Insegnante', onchange: (e) => { tid = Number(e.target.value); load(); } },
          D.teachers.map((x) => el('option', { value: x.id, selected: x.id === t.id }, `${x.name}${x.style ? ' · ' + x.style : ''}${x.active ? '' : ' (non attivo)'}`))) : null,
        el('span', { class: 'dot', style: `--tc:${t.color};width:12px;height:12px` }),
        el('b', null, t.name), t.style ? el('span', 'muted', t.style) : null,
        el('span', 'grow'),
        el('span', 'muted small', `${D.upcoming} lezioni in programma`));
      root.replaceChildren(...[head,
        intro ? el('div', 'muted small', D.staff
          ? 'Turni, assenze e disponibilità extra decidono quando l\'insegnante si può prenotare. Le lezioni già prenotate non vengono mai cancellate da qui.'
          : 'Qui decidi quando puoi essere prenotato: i tuoi turni settimanali, le date in cui non ci sei e le ore in più in date precise. La segreteria vede subito le modifiche.') : null,
        shiftsCard(), blocksCard(), extrasCard(), closuresCard()].filter(Boolean));
    }

    // ---------------- turni settimanali ----------------
    function shiftsCard() {
      const shifts = D.shifts.map((s) => ({ ...s }));
      const box = el('div', 'shifts');
      const tot = el('span', 'muted small');
      const msg = el('div');
      const draw = () => {
        tot.textContent = `${shifts.reduce((n, s) => n + Math.max(0, s.end_hour - s.start_hour), 0)} ore a settimana`;
        box.replaceChildren(...shifts.map((s, i) => {
          const day = el('select', { 'aria-label': 'Giorno' }, [1, 2, 3, 4, 5, 6, 0].map((w) => el('option', { value: w, selected: w === s.weekday }, cap(DOWL[w]))));
          const a = hourSelect(`av-sa-${i}`, s.start_hour), z = hourSelect(`av-sz-${i}`, s.end_hour);
          day.onchange = () => (s.weekday = Number(day.value)); a.onchange = () => { s.start_hour = Number(a.value); draw(); }; z.onchange = () => { s.end_hour = Number(z.value); draw(); };
          const o = D.opening.find((x) => x.weekday === s.weekday);
          const warn = !o || o.start_hour == null ? 'scuola chiusa' : (s.start_hour < o.start_hour || s.end_hour > o.end_hour) ? `la scuola è aperta ${pad(o.start_hour)}–${pad(o.end_hour)}` : '';
          return el('div', 'shift', day, a, '–', z, el('button', { class: 'btn icon', type: 'button', 'aria-label': 'Rimuovi turno', onclick: () => { shifts.splice(i, 1); draw(); } }, '×'),
            warn ? el('span', 'muted small', `(${warn})`) : null);
        }), el('button', { class: 'btn', type: 'button', style: 'align-self:flex-start', onclick: () => {
          const used = new Set(shifts.map((s) => s.weekday)); const w = [1, 2, 3, 4, 5, 6].find((x) => !used.has(x)) ?? 1;
          const o = D.opening.find((x) => x.weekday === w && x.start_hour != null);
          shifts.push({ weekday: w, start_hour: o?.start_hour ?? 15, end_hour: o?.end_hour ?? 20 }); draw();
        } }, '+ Turno'));
      };
      const save = el('button', { class: 'btn primary', type: 'button' }, 'Salva turni');
      const doSave = async (force) => {
        msg.replaceChildren();
        const bad = shifts.find((s) => s.end_hour <= s.start_hour);
        if (bad) { msg.append(el('div', 'err', `${cap(DOWL[bad.weekday])}: l'ora di fine deve essere dopo l'inizio.`)); return; }
        save.disabled = true;
        try {
          const r = await rpc('avail_save_shifts', { p_teacher_id: tid, p_shifts: shifts, p_force: force });
          if (!r.ok) {
            msg.append(el('div', 'note', el('b', null, r.error), el('ul', { style: 'margin:6px 0 0;padding-left:18px' }, r.conflicts.slice(0, 8).map((c) => el('li', null, lessonText(c)))),
              el('div', { class: 'row', style: 'justify-content:flex-start;margin-top:8px' }, el('button', { class: 'btn primary', type: 'button', onclick: () => doSave(true) }, 'Salva comunque'))));
          } else { toast('Turni salvati'); await load(); return; }
        } catch (x) { msg.append(el('div', 'err', x.message)); }
        save.disabled = false;
      };
      save.onclick = () => doSave(false);
      draw();
      return el('div', 'card', el('h2', null, 'Turni settimanali'), el('div', 'muted small', D.staff ? 'Le fasce orarie di ogni settimana in cui l\'insegnante è prenotabile.' : 'Le fasce orarie di ogni settimana in cui sei prenotabile.'), box, tot, msg, el('div', 'row', save));
    }

    // ---------------- assenze ----------------
    function blocksCard() {
      const today = D.today;
      const from = el('input', { type: 'date', id: 'av-bf', value: today, min: today });
      const to = el('input', { type: 'date', id: 'av-bt', value: today, min: today });
      from.onchange = () => { if (!to.value || to.value < from.value) to.value = from.value; to.min = from.value; };
      const whole = el('input', { type: 'checkbox', id: 'av-bw', checked: true });
      const a = hourSelect('av-ba', 15), z = hourSelect('av-bz', 20);
      const hrs = el('div', 'shift', el('span', 'muted small', 'dalle'), a, el('span', 'muted small', 'alle'), z);
      const syncW = () => (hrs.hidden = whole.checked); whole.onchange = syncW; syncW();
      const why = el('select', { id: 'av-bwhy' }, ['Ferie', 'Malattia', 'Impegno personale', 'Formazione / stage', 'Spettacolo / evento', 'Non disponibile'].map((x) => el('option', { value: x }, x)));
      const msg = el('div');
      const go = el('button', { class: 'btn primary', type: 'button' }, 'Blocca le date');
      const doBlock = async (force) => {
        msg.replaceChildren();
        const s = whole.checked ? 0 : Number(a.value), e = whole.checked ? 24 : Number(z.value);
        if (e <= s) { msg.append(el('div', 'err', 'L\'ora di fine deve essere dopo l\'inizio.')); return; }
        go.disabled = true;
        try {
          const r = await rpc('avail_block', { p_teacher_id: tid, p_date: from.value, p_until: to.value || from.value, p_start_hour: s, p_end_hour: e, p_title: why.value, p_force: force });
          if (!r.ok) {
            msg.append(el('div', 'note', el('b', null, r.error), el('ul', { style: 'margin:6px 0 0;padding-left:18px' }, r.conflicts.slice(0, 10).map((c) => el('li', null, lessonText(c)))),
              r.can_force ? el('div', { class: 'row', style: 'justify-content:flex-start;margin-top:8px' }, el('button', { class: 'btn danger', type: 'button', onclick: () => doBlock(true) }, 'Blocca comunque')) : null));
          } else { toast(r.created ? `Bloccat${r.created === 1 ? 'o 1 giorno' : 'i ' + r.created + ' giorni'}` : 'Quelle date erano già bloccate'); await load(); return; }
        } catch (x) { msg.append(el('div', 'err', x.message)); }
        go.disabled = false;
      };
      go.onclick = () => doBlock(false);

      const groups = groupBlocks(D.blocks);
      const list = groups.length ? el('div', 'table-wrap', el('table', null,
        el('thead', null, el('tr', null, el('th', null, 'Quando'), el('th', null, 'Orario'), el('th', null, 'Motivo'), el('th', null, ''))),
        el('tbody', null, groups.map((g) => el('tr', null,
          el('td', null, g.from === g.to ? fmtDay(g.from) : `dal ${fmtDay(g.from)} al ${fmtDay(g.to)}`, g.lessons ? el('div', { class: 'small', style: 'color:var(--warn)' }, `⚠ ${g.lessons} lezion${g.lessons === 1 ? 'e' : 'i'} prenotat${g.lessons === 1 ? 'a' : 'e'}`) : null),
          el('td', null, hours(g.start_hour, g.end_hour)),
          el('td', null, g.title, g.by ? el('div', 'muted small', `inserita da ${g.by}`) : null),
          el('td', null, el('button', { class: 'btn', type: 'button', onclick: async (ev) => {
            ev.target.disabled = true;
            try { for (const id of g.ids) await rpc('avail_unblock', { p_id: id }); toast('Assenza tolta'); await load(); }
            catch (x) { toast(x.message); ev.target.disabled = false; }
          } }, 'Togli'))))))) : el('p', 'muted', 'Nessuna assenza in programma.');

      return el('div', 'card', el('h2', null, 'Assenze e date bloccate'),
        el('div', 'muted small', D.staff ? 'Nelle date bloccate l\'insegnante non si può prenotare. Se ci sono lezioni già prenotate te lo segnaliamo prima.'
          : 'Nelle date bloccate non ti si può prenotare. Se hai già lezioni prenotate in quel periodo, chiedi prima alla segreteria di spostarle.'),
        el('div', 'fields', field('Dal', from), field('Al', to), field('Motivo', why)),
        el('label', 'check', whole, el('span', null, 'Tutto il giorno')), hrs, msg, el('div', 'row', go),
        el('div', 'label', 'In programma'), list);
    }

    // ---------------- disponibilità extra ----------------
    function extrasCard() {
      const today = D.today;
      const day = el('input', { type: 'date', id: 'av-ed', value: today, min: today });
      const a = hourSelect('av-ea', 10), z = hourSelect('av-ez', 13);
      const note = el('input', { type: 'text', id: 'av-en', placeholder: 'es. recupero, stage, lezioni private', maxlength: 120 });
      const msg = el('div');
      const go = el('button', { class: 'btn primary', type: 'button' }, 'Aggiungi disponibilità');
      day.onchange = () => {
        const o = D.opening.find((x) => x.weekday === parse(day.value).getDay());
        if (o?.start_hour != null) { a.value = o.start_hour; z.value = Math.min(o.end_hour, o.start_hour + 3); }
      };
      go.onclick = async () => {
        msg.replaceChildren(); go.disabled = true;
        try { await rpc('avail_extra_add', { p_teacher_id: tid, p_date: day.value, p_start_hour: Number(a.value), p_end_hour: Number(z.value), p_note: note.value }); toast('Disponibilità aggiunta'); await load(); return; }
        catch (x) { msg.append(el('div', 'err', x.message)); }
        go.disabled = false;
      };
      const list = D.extras.length ? el('div', 'table-wrap', el('table', null,
        el('thead', null, el('tr', null, el('th', null, 'Data'), el('th', null, 'Orario'), el('th', null, 'Note'), el('th', null, ''))),
        el('tbody', null, D.extras.map((e) => el('tr', null,
          el('td', null, fmtDay(e.date), e.lessons ? el('div', 'muted small', `${e.lessons} lezion${e.lessons === 1 ? 'e prenotata' : 'i prenotate'}`) : null),
          el('td', null, hours(e.start_hour, e.end_hour)),
          el('td', null, e.note || '—', e.by ? el('div', 'muted small', `inserita da ${e.by}`) : null),
          el('td', null, el('button', { class: 'btn', type: 'button', onclick: async (ev) => {
            ev.target.disabled = true;
            try { await rpc('avail_extra_delete', { p_id: e.id }); toast('Disponibilità tolta'); await load(); } catch (x) { toast(x.message); ev.target.disabled = false; }
          } }, 'Togli'))))))) : el('p', 'muted', 'Nessuna disponibilità extra in programma.');
      return el('div', 'card', el('h2', null, 'Disponibilità extra'),
        el('div', 'muted small', 'Ore in più in una data precisa, anche fuori dai turni (per esempio un sabato mattina). Valgono solo negli orari di apertura della scuola.'),
        el('div', 'fields', field('Data', day), el('div', 'field', el('span', 'lbl', 'Orario'), el('div', 'shift', a, '–', z)), field('Note', note)), msg, el('div', 'row', go),
        el('div', 'label', 'In programma'), list);
    }

    function closuresCard() {
      if (!D.closures.length) return null;
      return el('div', 'card', el('h2', null, 'Chiusure della scuola'), el('div', 'muted small', 'Decise dalla segreteria: in queste date nessuno è prenotabile.'),
        el('ul', { style: 'margin:0;padding-left:18px' }, groupBlocks(D.closures.map((c, i) => ({ ...c, id: i, lessons: 0 }))).map((g) =>
          el('li', null, `${g.from === g.to ? fmtDay(g.from) : `dal ${fmtDay(g.from)} al ${fmtDay(g.to)}`} · ${hours(g.start_hour, g.end_hour)} · ${g.title}`))));
    }

    await load();
  }

  /** Per la segreteria: ultime modifiche fatte dagli insegnanti. */
  async function changesCard({ rpc, onOpen }) {
    let list = [];
    try { list = await rpc('admin_avail_changes', { p_days: 14 }); } catch { return null; }
    if (!list.length) return null;
    // giorni consecutivi della stessa assenza in una riga sola
    list.sort((a, b) => a.teacher_id - b.teacher_id || a.kind.localeCompare(b.kind) || a.date.localeCompare(b.date));
    const rows = [];
    for (const c of list) {
      const l = rows[rows.length - 1];
      if (l && l.kind === c.kind && l.teacher_id === c.teacher_id && l.start_hour === c.start_hour && l.end_hour === c.end_hour && l.note === c.note && addDays(l.to, 1) === c.date) { l.to = c.date; l.lessons += c.lessons; }
      else rows.push({ ...c, to: c.date });
    }
    list = rows;
    return el('div', 'card', el('h2', null, 'Novità dagli insegnanti ', el('small', { class: 'muted', style: 'font-weight:500;font-size:12.5px;margin-left:6px' }, 'ultimi 14 giorni')),
      el('div', 'table-wrap', el('table', null, el('tbody', null, list.map((c) => el('tr', null,
        el('td', null, el('b', null, c.teacher)),
        el('td', null, c.kind === 'extra' ? el('span', 'pill ok', '+ disponibile') : el('span', 'pill warn', 'assente')),
        el('td', null, `${c.to !== c.date ? `dal ${fmtDay(c.date)} al ${fmtDay(c.to)}` : fmtDay(c.date)} · ${hours(c.start_hour, c.end_hour)}`, c.note ? el('div', 'muted small', c.note) : null,
          c.lessons ? el('div', { class: 'small', style: 'color:var(--warn)' }, `⚠ ${c.lessons} lezion${c.lessons === 1 ? 'e' : 'i'} da spostare`) : null),
        el('td', null, onOpen ? el('button', { class: 'btn', type: 'button', onclick: () => onOpen(c.teacher_id) }, 'Apri') : null)))))));
  }

  window.Disponibilita = { mount, changesCard };
})();
