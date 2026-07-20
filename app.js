/* what-the-fork — dashboard logic.
   Two modes:
     "fork" — pick a fork DB; columns = features, rows = manufacturers (expandable to cars)
     "car"  — pick manufacturer + model; columns = forks, rows = features   */
'use strict';

const STATUS = {
  yes:     { glyph: '✓', label: 'Supported',       cls: 's-yes' },
  no:      { glyph: '✕', label: 'Not supported',   cls: 's-no' },
  partial: { glyph: '◐', label: 'Partial support', cls: 's-partial' },
  unknown: { glyph: '?',      label: 'Unknown',         cls: 's-unknown' },
  na:      { glyph: '—', label: 'Not applicable',  cls: 's-na' },
};

const state = {
  manifest: null,
  dbs: {},            // manifest id -> parsed DB (or null after failed load)
  mode: 'fork',
  forkId: null,
  mfrKey: null,
  modelKey: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/* ---------- tooltip ---------- */

const tip = $('#tooltip');

function placeTip(x, y) {
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let left = x + pad, top = y + pad;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - pad;
  tip.style.left = Math.max(4, left) + 'px';
  tip.style.top = Math.max(4, top) + 'px';
}

function bindTip(el, htmlFn) {
  el.addEventListener('mouseenter', (e) => { tip.innerHTML = htmlFn(); tip.classList.add('show'); placeTip(e.clientX, e.clientY); });
  el.addEventListener('mousemove', (e) => placeTip(e.clientX, e.clientY));
  el.addEventListener('mouseleave', () => tip.classList.remove('show'));
  el.addEventListener('focus', () => {
    tip.innerHTML = htmlFn(); tip.classList.add('show');
    const r = el.getBoundingClientRect();
    placeTip(r.left + r.width / 2, r.bottom);
  });
  el.addEventListener('blur', () => tip.classList.remove('show'));
}

/* ---------- data access helpers ---------- */

function loadedDbs() {
  return (state.manifest?.databases || [])
    .filter((d) => d.status === 'available' && state.dbs[d.id])
    .map((d) => ({ entry: d, db: state.dbs[d.id] }));
}

// A cell entry may be "yes" or {status, note} (+ override metadata)
function normEntry(raw) {
  if (raw == null) return { status: 'unknown', note: null, issue: null, override: false };
  if (typeof raw === 'string') return { status: STATUS[raw] ? raw : 'unknown', note: null, issue: null, override: false };
  const s = STATUS[raw.status] ? raw.status : 'unknown';
  return { status: s, note: raw.note || null, issue: raw.issue || null, override: !!raw.override };
}

/* Community corrections: data/<id>.overrides.json entries beat generated data. */
function mergeOverrides(db, ov) {
  for (const o of ov.overrides || []) {
    const feat = (db.features || []).find((f) => norm(f.id || f.abbrev) === norm(o.feature));
    if (!feat) continue;
    for (const m of db.manufacturers || []) {
      const car = (m.cars || []).find((c) => norm(c.id || c.name) === norm(o.car));
      if (!car) continue;
      car.features = car.features || {};
      car.features[feat.id] = { status: o.status, note: o.note, issue: o.issue, override: true };
    }
  }
}

/* Resolution order: car entry -> manufacturer-wide default -> unknown. */
function resolveEntry(mfr, car, featId) {
  const own = (car.features || {})[featId];
  if (own != null) return normEntry(own);
  const inh = ((mfr && mfr.features) || {})[featId];
  if (inh != null) return Object.assign(normEntry(inh), { inherited: true });
  return normEntry(null);
}

function aggregate(statuses) {
  const set = new Set(statuses);
  set.delete('na');
  if (set.size === 0) return 'na';
  if (set.size === 1) return [...set][0];
  if (set.has('yes') || set.has('partial')) return 'partial';
  return 'unknown'; // mix of no + unknown
}

function statusChip(status) {
  const st = STATUS[status];
  return `<span class="${st.cls}"><span class="led">${st.glyph}</span></span>`;
}

/* ---------- fetch ---------- */

async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

async function loadDb(entry) {
  if (state.dbs[entry.id] !== undefined) return state.dbs[entry.id];
  try {
    const db = await fetchJson(entry.file);
    try {
      mergeOverrides(db, await fetchJson(entry.file.replace(/\.json$/, '.overrides.json')));
    } catch { /* no overrides file — fine */ }
    state.dbs[entry.id] = db;
  } catch (err) {
    console.error('Failed to load', entry.file, err);
    state.dbs[entry.id] = null;
  }
  return state.dbs[entry.id];
}

/* ---------- mode 1: by fork ---------- */

function featTipHtml(feat) {
  const sub = [feat.category, feat.origin ? `from ${feat.origin}` : null]
    .filter(Boolean).join(' · ');
  return `<div class="tt-title">${esc(feat.abbrev)} — ${esc(feat.name)}</div>` +
    (sub ? `<div class="tt-sub">${esc(sub)}</div>` : '') +
    `<div class="tt-body">${esc(feat.description || 'No description.')}</div>`;
}

const HL_TIP = '<div class="tt-note">★ Explicitly referenced in this fork\'s code</div>';
const INH_TIP = '<div class="tt-note">Manufacturer-wide setting</div>';

function cellTipHtml(title, sub, status, note) {
  const st = STATUS[status];
  return `<div class="tt-title">${esc(title)}</div>` +
    (sub ? `<div class="tt-sub">${esc(sub)}</div>` : '') +
    `<div class="tt-body">${statusChip(status)} ${esc(st.label)}</div>` +
    (note ? `<div class="tt-note">${esc(note)}</div>` : '');
}

function makeCell(status, tipFn, extraClass) {
  const td = document.createElement('td');
  const st = STATUS[status];
  td.className = `cell ${st.cls}` + (extraClass ? ` ${extraClass}` : '');
  td.innerHTML = `<span class="led">${st.glyph}</span>`;
  if (tipFn) { td.classList.add('has-note'); bindTip(td, tipFn); }
  return td;
}

/* ---------- dispute popup (option 1: prefilled GitHub issue) ---------- */

const DEFAULT_ISSUES_REPO = 'dirkpetersen/what-the-fork';
let disputeCtx = null;

function markOverride(td) {
  td.classList.add('overridden');
  td.appendChild(Object.assign(document.createElement('span'), { className: 'ovr-dot' }));
}

function enableDispute(td, ctx) {
  td.classList.add('clickable');
  td.tabIndex = 0;
  const open = () => { tip.classList.remove('show'); openDispute(ctx); };
  td.addEventListener('click', open);
  td.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });
}

function openDispute(ctx) {
  disputeCtx = ctx;
  const dlg = $('#dispute-modal');
  $('#dm-title').textContent = `${ctx.featAbbrev} — ${ctx.featName}`;
  $('#dm-sub').textContent = `${ctx.carName} · ${ctx.forkName}` + (ctx.branch ? ` (${ctx.branch})` : '');
  $('#dm-current').innerHTML =
    `Current: ${statusChip(ctx.entry.status)} <b>${esc(STATUS[ctx.entry.status].label)}</b>` +
    (ctx.entry.note ? `<div class="dm-note">${esc(ctx.entry.note)}</div>` : '') +
    (ctx.entry.issue
      ? `<div class="dm-note">◆ Community correction — <a href="${esc(ctx.entry.issue)}" target="_blank" rel="noopener">source issue ↗</a></div>`
      : '');
  for (const r of dlg.querySelectorAll('input[name="proposed"]')) r.checked = false;
  $('#dm-evidence').value = '';
  dlg.showModal();
}

function issueUrl(ctx, proposed, evidence) {
  const repo = state.manifest?.issues_repo || DEFAULT_ISSUES_REPO;
  const title = `[${ctx.forkId}] ${ctx.carId} / ${ctx.featId} — status dispute`;
  const meta = {
    fork: ctx.forkId, branch: ctx.branch || null, car: ctx.carId, feature: ctx.featId,
    current: ctx.entry.status, proposed: proposed || null,
  };
  const body = [
    '### Cell', '',
    '| | |', '|---|---|',
    `| Fork | ${ctx.forkName} (\`${ctx.forkId}\`${ctx.branch ? `, branch \`${ctx.branch}\`` : ''}) |`,
    `| Car | ${ctx.carName} (\`${ctx.carId}\`) |`,
    `| Feature | ${ctx.featAbbrev} — ${ctx.featName} (\`${ctx.featId}\`) |`,
    `| Current status | \`${ctx.entry.status}\` |`,
    ctx.entry.note ? `| Current note | ${ctx.entry.note} |` : null,
    '', '### Proposed status', '', proposed ? `\`${proposed}\`` : '_(not specified)_',
    '', '### Evidence / explanation', '', evidence || '_(none given)_',
    '', `<!-- wtf-dispute ${JSON.stringify(meta)} -->`,
  ].filter((l) => l !== null).join('\n');
  return `https://github.com/${repo}/issues/new?labels=data-dispute` +
    `&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

function initDisputeModal() {
  const dlg = $('#dispute-modal');
  $('#dm-submit').addEventListener('click', () => {
    if (!disputeCtx) return;
    const proposed = dlg.querySelector('input[name="proposed"]:checked')?.value || null;
    window.open(issueUrl(disputeCtx, proposed, $('#dm-evidence').value.trim()), '_blank', 'noopener');
    dlg.close();
  });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}

const TT_HINT = '<div class="tt-hint">Click to comment or dispute this status</div>';

function renderForkMatrix() {
  const shell = $('#matrix-shell');
  const db = state.dbs[state.forkId];
  if (!db) { showState(shell, 'No data', 'This fork database could not be loaded.'); renderMeta(null); return; }
  renderMeta(db);

  const feats = db.features || [];
  const table = document.createElement('table');
  table.className = 'matrix';

  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  corner.textContent = 'Manufacturer / Car';
  hr.appendChild(corner);
  for (const feat of feats) {
    const th = document.createElement('th');
    th.className = 'feat';
    const span = document.createElement('span');
    span.className = 'abbr';
    span.tabIndex = 0;
    span.textContent = feat.abbrev;
    bindTip(span, () => featTipHtml(feat));
    th.appendChild(span);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let rowIdx = 0;
  for (const mfr of db.manufacturers || []) {
    const cars = mfr.cars || [];
    const mtr = document.createElement('tr');
    mtr.className = 'mfr';
    mtr.setAttribute('aria-expanded', 'false');
    mtr.style.animationDelay = `${Math.min(rowIdx * 45, 500)}ms`;
    rowIdx++;

    const rh = document.createElement('td');
    rh.className = 'rowhead';
    rh.tabIndex = 0;
    rh.setAttribute('role', 'button');
    rh.innerHTML = `<span class="chev">▸</span>${esc(mfr.name)}` +
      `<span class="mfr-count">${cars.length} car${cars.length === 1 ? '' : 's'}</span>`;
    mtr.appendChild(rh);

    for (const feat of feats) {
      const entries = cars.map((c) => resolveEntry(mfr, c, feat.id));
      const agg = aggregate(entries.map((e) => e.status));
      const breakdown = cars.map((c, i) =>
        `${statusChip(entries[i].status)} ${esc(c.name)}`).join('<br>');
      mtr.appendChild(makeCell(agg, () =>
        `<div class="tt-title">${esc(feat.abbrev)} — ${esc(mfr.name)}</div>` +
        `<div class="tt-body">${statusChip(agg)} ${esc(STATUS[agg].label)} (aggregate)</div>` +
        `<div class="tt-note">${breakdown}</div>`));
    }
    tbody.appendChild(mtr);

    const carRows = [];
    for (const car of cars) {
      const ctr = document.createElement('tr');
      ctr.className = 'car';
      const crh = document.createElement('td');
      crh.className = 'rowhead';
      if (car.highlight) {
        ctr.classList.add('hl');
        crh.innerHTML = `<span class="hl-star">★</span>${esc(car.name)}`;
      } else {
        crh.textContent = car.name;
      }
      if (car.note || car.highlight) bindTip(crh, () =>
        `<div class="tt-title">${esc(car.name)}</div>` +
        (car.note ? `<div class="tt-body">${esc(car.note)}</div>` : '') +
        (car.highlight ? HL_TIP : ''));
      ctr.appendChild(crh);
      for (const feat of feats) {
        const entry = resolveEntry(mfr, car, feat.id);
        const td = makeCell(entry.status, () =>
          cellTipHtml(`${feat.abbrev} — ${feat.name}`, car.name, entry.status, entry.note) +
          (entry.inherited ? INH_TIP : '') +
          (entry.override ? '<div class="tt-note">◆ Community correction</div>' : '') + TT_HINT);
        if (entry.override) markOverride(td);
        enableDispute(td, {
          forkId: db.fork?.id || state.forkId, forkName: db.fork?.name || state.forkId,
          branch: db.fork?.branch || null,
          carId: car.id || norm(car.name), carName: car.name,
          featId: feat.id, featAbbrev: feat.abbrev, featName: feat.name, entry,
        });
        ctr.appendChild(td);
      }
      tbody.appendChild(ctr);
      carRows.push(ctr);
    }

    const toggle = () => {
      const open = mtr.getAttribute('aria-expanded') === 'true';
      mtr.setAttribute('aria-expanded', String(!open));
      carRows.forEach((r) => r.classList.toggle('open', !open));
    };
    rh.addEventListener('click', toggle);
    rh.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
  }
  table.appendChild(tbody);
  shell.replaceChildren(table);
}

function renderMeta(db) {
  const meta = $('#meta');
  if (!db || state.mode !== 'fork') { meta.classList.remove('show'); return; }
  const f = db.fork || {};
  const isSample = /sample|hand/i.test(f.generator?.note || '');
  const carCount = (db.manufacturers || []).reduce((n, m) => n + (m.cars || []).length, 0);
  meta.innerHTML =
    `<span class="fork-name">${esc(f.name || state.forkId)}</span>` +
    (isSample ? '<span class="badge-sample">sample data</span>' : '') +
    (f.branch ? `<span class="kv">branch <b>${esc(f.branch)}</b></span>` : '') +
    (f.base ? `<span class="kv">base <b>${esc(f.base)}</b></span>` : '') +
    `<span class="kv"><b>${(db.features || []).length}</b> features · <b>${carCount}</b> cars</span>` +
    (f.repo ? `<span class="kv"><a href="${esc(f.repo)}" target="_blank" rel="noopener">repo ↗</a></span>` : '') +
    (f.generated_at ? `<span class="kv">generated <b>${esc(f.generated_at)}</b></span>` : '') +
    (f.description ? `<span class="fork-desc">${esc(f.description)}</span>` : '');
  meta.classList.add('show');
}

/* ---------- mode 2: by car ---------- */

function mfrUnion() {
  const map = new Map();
  for (const { db } of loadedDbs()) {
    for (const m of db.manufacturers || []) {
      const k = norm(m.id || m.name);
      if (!map.has(k)) map.set(k, { key: k, name: m.name });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* Variants of the same model — "(with HDA II)", "(Raven)", year ranges — are
   grouped under one model root so forks that split rows differently still
   line up. Variant detail is preserved in the cell tooltips. */
function stripVariant(name) {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:19|20)\d{2}(?:\s*[-–—]\s*(?:19|20)?\d{2})?\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function yearsIn(name) {
  const out = [];
  for (const m of String(name).matchAll(/\b((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)?\d{2}))?\b/g)) {
    const a = +m[1];
    out.push(a);
    if (m[2]) {
      let b = +m[2];
      if (b < 100) b += Math.floor(a / 100) * 100;
      out.push(b);
    }
  }
  return out;
}

function modelRoot(car, mfrName) {
  let base = stripVariant(car.name);
  if (mfrName) {
    const re = new RegExp('^' + String(mfrName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i');
    base = base.replace(re, '');
  }
  return norm(base) || norm(car.id || car.name);
}

function modelUnion(mfrKey) {
  const map = new Map();
  for (const { db } of loadedDbs()) {
    const m = (db.manufacturers || []).find((x) => norm(x.id || x.name) === mfrKey);
    if (!m) continue;
    for (const car of m.cars || []) {
      const k = modelRoot(car, m.name);
      if (!k) continue;
      const brandRe = new RegExp('^' + String(m.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i');
      const base = (stripVariant(car.name) || car.name).replace(brandRe, '');
      const e = map.get(k) || { key: k, base, years: [] };
      if (base && base.length < e.base.length) e.base = base;
      e.years.push(...yearsIn(car.name));
      map.set(k, e);
    }
  }
  return [...map.values()].map((e) => {
    const lo = e.years.length ? Math.min(...e.years) : null;
    const hi = e.years.length ? Math.max(...e.years) : null;
    return { key: e.key, name: lo ? `${e.base} ${lo}${hi > lo ? '–' + hi : ''}` : e.base };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

function findCars(db, mfrKey, rootKey) {
  const m = (db.manufacturers || []).find((x) => norm(x.id || x.name) === mfrKey);
  if (!m) return null;
  const cars = (m.cars || []).filter((c) => modelRoot(c, m.name) === rootKey);
  return cars.length ? { mfr: m, cars } : null;
}

function renderCarControls() {
  const mfrSel = $('#mfr-select');
  const modelSel = $('#model-select');
  const mfrs = mfrUnion();
  if (!mfrs.length) return;
  if (!state.mfrKey || !mfrs.some((m) => m.key === state.mfrKey)) state.mfrKey = mfrs[0].key;
  mfrSel.innerHTML = mfrs.map((m) =>
    `<option value="${esc(m.key)}"${m.key === state.mfrKey ? ' selected' : ''}>${esc(m.name)}</option>`).join('');

  const models = modelUnion(state.mfrKey);
  if (!state.modelKey || !models.some((m) => m.key === state.modelKey)) state.modelKey = models[0]?.key || null;
  modelSel.innerHTML = models.map((m) =>
    `<option value="${esc(m.key)}"${m.key === state.modelKey ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
}

function renderCarMatrix() {
  const shell = $('#matrix-shell');
  renderMeta(null);
  const forks = loadedDbs().map(({ entry, db }) => {
    const hit = findCars(db, state.mfrKey, state.modelKey);
    return {
      entry, db, mfr: hit ? hit.mfr : null, cars: hit ? hit.cars : null,
      featIndex: new Map((db.features || []).map((f) => [norm(f.id || f.abbrev), f])),
    };
  });
  if (!forks.length || !state.modelKey) {
    showState(shell, 'No car selected', 'Pick a manufacturer and model above.');
    return;
  }
  const modelName = (modelUnion(state.mfrKey).find((m) => m.key === state.modelKey) || {}).name || state.modelKey;

  // Row union: every feature of every fork that lists this car, in fork order.
  const rows = new Map();
  for (const fk of forks) {
    if (!fk.cars) continue;
    for (const feat of fk.db.features || []) {
      const k = norm(feat.id || feat.abbrev);
      if (!rows.has(k)) rows.set(k, { key: k, abbrev: feat.abbrev, name: feat.name });
    }
  }

  const table = document.createElement('table');
  table.className = 'matrix';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'corner';
  corner.textContent = 'Feature';
  hr.appendChild(corner);
  for (const fk of forks) {
    const th = document.createElement('th');
    th.className = 'feat';
    const span = document.createElement('span');
    span.className = 'abbr';
    span.tabIndex = 0;
    span.textContent = fk.db.fork?.name || fk.entry.label;
    bindTip(span, () => {
      const f = fk.db.fork || {};
      return `<div class="tt-title">${esc(f.name || fk.entry.label)}</div>` +
        (f.branch ? `<div class="tt-sub">branch ${esc(f.branch)}</div>` : '') +
        `<div class="tt-body">${esc(f.description || '')}</div>` +
        (fk.cars
          ? `<div class="tt-note">Listed as: ${fk.cars.map((c) => esc(c.name)).join(' · ')}</div>`
          : `<div class="tt-note">This car is not listed in this fork's database.</div>`);
    });
    th.appendChild(span);
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let rowIdx = 0;
  for (const row of rows.values()) {
    const tr = document.createElement('tr');
    tr.className = 'mfr flat';
    tr.style.animationDelay = `${Math.min(rowIdx * 25, 500)}ms`;
    rowIdx++;
    const rh = document.createElement('td');
    rh.className = 'rowhead';
    rh.tabIndex = 0;
    rh.innerHTML = `<b>${esc(row.abbrev)}</b><span class="feat-name"> ${esc(row.name)}</span>`;
    const defs = forks.filter((fk) => fk.featIndex.has(row.key));
    bindTip(rh, () => {
      const feat = defs[0]?.featIndex.get(row.key);
      return feat ? featTipHtml(feat) : `<div class="tt-title">${esc(row.abbrev)}</div>`;
    });
    tr.appendChild(rh);

    for (const fk of forks) {
      const forkName = fk.db.fork?.name || fk.entry.label;
      const ctx = (featId, featAbbrev, featName, entry) => ({
        forkId: fk.entry.id, forkName, branch: fk.db.fork?.branch || null,
        carId: state.modelKey, carName: modelName,
        featId, featAbbrev, featName, entry,
      });
      if (!fk.cars) {
        const entry = { status: 'na', note: "Car not listed in this fork's database.", issue: null, override: false };
        const td = makeCell('na', () =>
          cellTipHtml(`${row.abbrev} — ${forkName}`, null, 'na', entry.note) + TT_HINT);
        enableDispute(td, ctx(row.key, row.abbrev, row.name, entry));
        tr.appendChild(td);
        continue;
      }
      const feat = fk.featIndex.get(row.key);
      if (!feat) {
        const entry = { status: 'no', note: 'Feature not present in this fork.', issue: null, override: false };
        const td = makeCell('no', () =>
          cellTipHtml(`${row.abbrev} — ${forkName}`, null, 'no', entry.note) + TT_HINT);
        enableDispute(td, ctx(row.key, row.abbrev, row.name, entry));
        tr.appendChild(td);
        continue;
      }
      const entries = fk.cars.map((c) => resolveEntry(fk.mfr, c, feat.id));
      const agg = aggregate(entries.map((e) => e.status));
      const single = fk.cars.length === 1 ? entries[0] : null;
      const breakdown = fk.cars.length > 1
        ? fk.cars.map((c, i) => `${statusChip(entries[i].status)} ${esc(c.name)}` +
            (entries[i].note ? ` — ${esc(entries[i].note)}` : '')).join('<br>')
        : '';
      const entry = {
        status: agg,
        note: single ? (single.note || feat.description) : null,
        issue: single ? single.issue : null,
        override: entries.some((e) => e.override),
      };
      const td = makeCell(agg, () =>
        cellTipHtml(`${feat.abbrev} — ${feat.name}`, forkName, agg, entry.note) +
        (breakdown ? `<div class="tt-note">${breakdown}</div>` : '') +
        (single && single.inherited ? INH_TIP : '') +
        (fk.cars.some((c) => c.highlight) ? HL_TIP : '') +
        (entry.override ? '<div class="tt-note">◆ Community correction</div>' : '') + TT_HINT);
      if (entry.override) markOverride(td);
      enableDispute(td, ctx(feat.id, feat.abbrev, feat.name, entry));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  shell.replaceChildren(table);

  const planned = (state.manifest.databases || []).filter((d) => d.status !== 'available');
  const note = document.createElement('div');
  note.className = 'planned-note';
  note.textContent = planned.length
    ? `Not yet generated (missing from comparison): ${planned.map((d) => d.label).join(', ')}`
    : '';
  shell.appendChild(note);
}

/* ---------- shared UI ---------- */

function showState(shell, big, msg) {
  shell.innerHTML = `<div class="state-msg"><span class="big">${esc(big)}</span>${esc(msg)}</div>`;
}

function setMode(mode) {
  state.mode = mode;
  $('#mode-fork-btn').classList.toggle('active', mode === 'fork');
  $('#mode-car-btn').classList.toggle('active', mode === 'car');
  $('#mode-fork-btn').setAttribute('aria-pressed', String(mode === 'fork'));
  $('#mode-car-btn').setAttribute('aria-pressed', String(mode === 'car'));
  $('#fork-controls').hidden = mode !== 'fork';
  $('#car-controls').hidden = mode !== 'car';
  if (mode === 'fork') {
    renderForkMatrix();
  } else {
    const shell = $('#matrix-shell');
    showState(shell, 'Loading', 'Fetching all fork databases…');
    Promise.all((state.manifest.databases || [])
      .filter((d) => d.status === 'available')
      .map(loadDb))
      .then(() => { renderCarControls(); renderCarMatrix(); });
  }
}

async function init() {
  const shell = $('#matrix-shell');
  try {
    state.manifest = await fetchJson('data/manifest.json');
  } catch (err) {
    showState(shell, 'No manifest', 'Could not load data/manifest.json. If you opened this page from disk, serve it instead: python3 -m http.server');
    return;
  }

  const sel = $('#fork-select');
  sel.innerHTML = (state.manifest.databases || []).map((d) => {
    const dis = d.status !== 'available';
    return `<option value="${esc(d.id)}"${dis ? ' disabled' : ''}>${esc(d.label)}${dis ? ' — not yet generated' : ''}</option>`;
  }).join('');

  const first = (state.manifest.databases || []).find((d) => d.status === 'available');
  if (!first) { showState(shell, 'No databases', 'The manifest lists no available fork databases yet. Run generate_db.py.'); return; }
  state.forkId = first.id;
  sel.value = first.id;

  sel.addEventListener('change', async () => {
    state.forkId = sel.value;
    const entry = state.manifest.databases.find((d) => d.id === sel.value);
    await loadDb(entry);
    renderForkMatrix();
  });
  $('#mfr-select').addEventListener('change', (e) => {
    state.mfrKey = e.target.value;
    state.modelKey = null;
    renderCarControls();
    renderCarMatrix();
  });
  $('#model-select').addEventListener('change', (e) => {
    state.modelKey = e.target.value;
    renderCarMatrix();
  });
  $('#mode-fork-btn').addEventListener('click', () => setMode('fork'));
  $('#mode-car-btn').addEventListener('click', () => setMode('car'));
  initDisputeModal();

  await loadDb(first);
  renderForkMatrix();
}

init();
