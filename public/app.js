// THE NEXT FRAME - client. It draws what the server says is real and asks the
// server to act. It never decides an outcome and never holds authoritative state.
const API = (window.API_BASE || '') + '/api';
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('en-US');
const compact = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : fmt(n));
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} } };
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const GLYPHS = ['○', '△', '▢', '✕', '◇', '☆'];
const glyphs = (p) => [...String(p)].map((c) => GLYPHS[c] || '?').join('');
const HUES = ['#f3c969', '#7cc6d6', '#c69cf0', '#f08a7b', '#9be0a8', '#e2e0f0', '#8f96d8'];

const S = {
  token: store.get('tnf.token'), laws: null, me: null, uni: null, regions: [], frontier: [], objects: new Map(), rels: [], others: [],
  sel: null, detail: null, action: null, focus: 1, amount: null, target: null, poss: null, result: null, busy: false, firstObject: null,
  lastInteraction: 0, lastMajor: 0, view: { cx: 120, cy: 120, k: 1.4 }, tab: 'universe',
};

async function api(path, opts = {}) {
  if (!navigator.onLine) throw new Error('You are offline. The universe is still moving without you.');
  const res = await fetch(API + path, { method: opts.body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token) { signOut(); throw new Error(data.error || 'Signed out.'); }
  if (!res.ok) throw new Error(data.error || 'The universe did not answer.');
  return data;
}

// ---------------------------------------------------------------- arrival
let mode = 'register';
function showGate() {
  $('#app').hidden = true; $('#gate').hidden = false;
  const form = $('#auth');
  const setMode = (m) => {
    mode = m;
    form.querySelectorAll('[role=tab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === m));
    form.querySelectorAll('[data-only]').forEach((el) => (el.hidden = el.dataset.only !== m));
    $('#emailLabel').textContent = m === 'login' ? 'Email or observer name' : 'Email';
    $('#authGo').textContent = m === 'login' ? 'Return to the universe' : 'Enter the universe';
    form.password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    $('#authError').textContent = '';
  };
  form.querySelectorAll('[role=tab]').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  setMode(store.get('tnf.known') ? 'login' : 'register');
  form.onsubmit = async (e) => {
    e.preventDefault();
    $('#authGo').disabled = true; $('#authError').textContent = '';
    try {
      const body = mode === 'login' ? { login: form.email.value, password: form.password.value } : { username: form.username.value, email: form.email.value, password: form.password.value };
      const out = await api('/auth/' + mode, { body });
      S.token = out.token; store.set('tnf.token', out.token); store.set('tnf.known', '1');
      form.password.value = '';
      await enter(out.firstArrival ? out.arrivedTick : null);
    } catch (err) { $('#authError').textContent = err.message; }
    $('#authGo').disabled = false;
  };
}
function signOut() { S.token = null; store.set('tnf.token', null); clearInterval(pulseTimer); location.reload(); }

async function veil(lines) {
  const v = $('#veil'); v.hidden = false; v.innerHTML = '';
  for (const text of lines) {
    const p = document.createElement('p'); p.textContent = text; v.replaceChildren(p);
    await wait(60); p.classList.add('on'); await wait(calm ? 1800 : 3000); p.classList.remove('on'); await wait(calm ? 100 : 1100);
  }
  v.hidden = true;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pulseTimer, pulses = 0;
async function enter(arrivedTick) {
  S.laws = S.laws || (await api('/laws'));
  const me = await api('/me');
  $('#gate').hidden = true; $('#app').hidden = false;
  await loadUniverse();
  const home = S.regions.find((r) => r.id === S.me.location) || S.regions[0];
  if (home) Object.assign(S.view, { cx: (home.gx + 0.5) * S.laws.regionSize, cy: (home.gy + 0.5) * S.laws.regionSize });
  fitView(); drawMap(); renderSheet();
  if (arrivedTick) {
    await veil(['Before you existed, the universe was already moving.', `You have arrived at tick ${fmt(arrivedTick)}.`]);
  } else if (me.away.ticks >= 40) showAway(me.away);
  api('/me/seen', { body: {} }).catch(() => {});
  const p = await api('/universe/pulse'); S.lastInteraction = p.lastInteraction; S.lastMajor = p.lastMajorEvent; S.lastEvent = p.lastEvent; S.social = p.social;
  clearInterval(pulseTimer); pulseTimer = setInterval(pulse, 8000);
}

function showAway(a) {
  const li = (t) => `<li>${t}</li>`;
  const items = [
    ...a.touched.map((t) => li(`<span>${esc(t.username)} ${esc(t.verb)} your ${esc(t.object)}.</span><span class="t">tick ${fmt(t.tick)}</span>`)),
    ...a.changed.map((c) => li(`<span>${esc(c.description)}</span><span class="t">tick ${fmt(c.tick)}</span>`)),
    ...a.events.map((e) => li(`<span class="${e.impact === 'cosmic' ? 'cosmic' : ''}">${esc(e.description)}</span><span class="t">tick ${fmt(e.tick)}</span>`)),
  ];
  openModal(`<h2>While you were away</h2>
    <p class="bigstat">+${fmt(a.ticks)}</p><p class="fine">ticks. The universe did not wait for you.</p>
    ${a.majorEvents ? `<p style="margin-top:12px">${a.majorEvents} major event${a.majorEvents === 1 ? '' : 's'} occurred.</p>` : ''}
    ${items.length ? `<ul class="rows">${items.join('')}</ul>` : '<p class="empty">Nothing you know of has changed. As far as you can tell.</p>'}
    <button class="primary" data-close>Continue</button>`);
}

// ---------------------------------------------------------------- state from the server
async function loadUniverse() {
  const u = await api('/universe');
  S.uni = u.universe; S.me = u.user; S.regions = u.regions; S.frontier = u.frontier; S.rels = u.relationships; S.others = u.others; S.firstObject = u.firstObject;
  S.objects = new Map(u.objects.map((o) => [o.id, o]));
  hud(); drawMap();
}
function hud() {
  if (!S.uni) return;
  $('#uEra').textContent = S.uni.era || '';
  $('#uTick').textContent = fmt(S.uni.tick); $('#uEntropy').textContent = Number(S.uni.entropy).toFixed(2); $('#uEnergy').textContent = compact(S.uni.totalEnergy);
  $('#meEnergy').textContent = fmt(S.me.energy); $('#meKnowledge').textContent = fmt(S.me.knowledge); $('#meInfluence').textContent = fmt(S.me.influence); $('#meRank').textContent = S.me.rank;
}
async function pulse() {
  if (document.hidden || S.busy) return;
  try {
    const p = await api(`/universe/pulse?after=${S.lastInteraction}&event=${S.lastEvent || 0}`);
    S.uni.tick = p.tick; S.uni.entropy = p.entropy; S.uni.era = p.era; S.me.energy = p.energy; hud();
    // The universe changes by itself too, so look again when something major happened and every so often regardless.
    const quiet = !S.result && !S.showCollapsed;
    if (p.lastInteraction === S.lastInteraction && quiet && (p.lastMajorEvent !== S.lastMajor || ++pulses % 5 === 0)) await loadUniverse();
    if (p.lastInteraction !== S.lastInteraction) {
      S.lastInteraction = p.lastInteraction;
      await loadUniverse();
      if (S.sel?.kind === 'object' && !S.result) refreshDetail();
    }
    // Something moved nearby. It may have been an observer. It may have been the universe.
    for (const r of p.ripples) ripple(r.x, r.y, '#c69cf0');
    S.lastEvent = p.lastEvent;
    const so = S.social || p.social, sn = p.social;
    if (sn.contact > so.contact) toast('<b>Contact</b><span class="law">An echo was answered. It was another observer.</span>', 'law');
    else if (sn.echo > so.echo) toast('<b>An echo</b><span class="law">Something echoed one of your signals.</span>', 'law');
    if (sn.message > so.message) toast('<b>A message</b><span class="law">An observer you found has spoken.</span>', 'law');
    if (sn.contact > so.contact || sn.echo > so.echo || sn.message > so.message) { if (S.tab === 'signals') signals($('#view-signals')); else $('#sigDot').hidden = false; }
    S.social = sn;
    if (p.lastMajorEvent !== S.lastMajor) {
      const feed = await api('/universe/feed');
      for (const e of feed.events.filter((e) => e.id > S.lastMajor).reverse().slice(-3)) toast(esc(e.description));
      S.lastMajor = p.lastMajorEvent;
    }
  } catch {}
}

// ---------------------------------------------------------------- the map
const map = $('#map');
const R = () => S.laws.regionSize;
function fitView() { const b = map.getBoundingClientRect(); S.view.k = Math.max(0.9, Math.min(b.width, b.height) / (R() * 1.25)); }
function applyView() {
  const b = map.getBoundingClientRect(); const { cx, cy, k } = S.view;
  map.setAttribute('viewBox', `${cx - b.width / 2 / k} ${cy - b.height / 2 / k} ${b.width / k} ${b.height / k}`);
}
const toWorld = (px, py) => { const b = map.getBoundingClientRect(); return { x: S.view.cx + (px - b.left - b.width / 2) / S.view.k, y: S.view.cy + (py - b.top - b.height / 2) / S.view.k }; };

function glyph(o) {
  if (!o.known) return '<circle class="unknown" r="5"/>';
  const e = o.energy;
  switch (o.type) {
    case 'particle': return '<circle r="2.6" fill="#ece9f7"/>';
    case 'cluster': return '<circle cx="-3" cy="2" r="2.4" fill="#ece9f7"/><circle cx="3" cy="2" r="2.4" fill="#ece9f7"/><circle cy="-3" r="2.4" fill="#ece9f7"/>';
    case 'dust': return '<circle r="17" fill="url(#g-dust)"/><circle r="1.5" cx="-4" cy="2" fill="#c69cf0"/><circle r="1.2" cx="5" cy="-3" fill="#c69cf0"/><circle r="1" cx="1" cy="6" fill="#c69cf0"/>';
    case 'field': return '<circle r="15" fill="url(#g-field)"/><circle r="5" fill="none" stroke="#7cc6d6" stroke-width=".8"/><circle r="10" fill="none" stroke="#7cc6d6" stroke-width=".5" stroke-opacity=".6"/>';
    case 'core': {
      const f = e != null ? Math.min(1, e / (o.threshold || 1000)) : 0, c = 2 * Math.PI * 10;
      return `<circle r="7" fill="#262b5c" stroke="#9a9cc2" stroke-width=".8"/><circle r="10" fill="none" stroke="#2c3263" stroke-width="1.6"/>${e != null ? `<circle r="10" fill="none" stroke="#f3c969" stroke-width="1.6" stroke-dasharray="${f * c} ${c}" transform="rotate(-90)"/>` : ''}`;
    }
    case 'star': { const r = 6 + Math.min(8, (e ?? 1500) / 500); return `<circle r="${r * 3.2}" fill="url(#g-star)" opacity=".55"/><circle r="${r}" fill="#fff3c9"/>`; }
    case 'planet': return '<circle r="6" fill="#7cc6d6"/><ellipse rx="10.5" ry="3" fill="none" stroke="#ece9f7" stroke-width=".7" transform="rotate(-18)"/>';
    case 'anomaly': return '<rect x="-5" y="-5" width="10" height="10" fill="none" stroke="#f08a7b" stroke-width="1.2" transform="rotate(45)"/><circle r="1.4" fill="#f08a7b"/>';
    case 'remnant': return '<circle r="3.5" fill="none" stroke="#6a6d99" stroke-width=".8" stroke-dasharray="1 2"/>';
    case 'replicator': return '<circle cx="-2.5" r="2.6" fill="#9be0a8"/><circle cx="2.5" r="2.6" fill="none" stroke="#9be0a8" stroke-width=".9"/>';
    case 'organism': return '<ellipse rx="6" ry="4.2" fill="#9be0a8" opacity=".85"/><circle cx="2" r="1.3" fill="#0d1024"/>';
    case 'ecosystem': return '<circle r="9" fill="none" stroke="#9be0a8" stroke-width=".8"/><circle cx="-3" cy="1" r="2.2" fill="#9be0a8"/><circle cx="3" cy="-2" r="1.8" fill="#9be0a8"/><circle cx="2" cy="4" r="1.4" fill="#9be0a8"/>';
    case 'intelligence': return '<circle r="10" fill="none" stroke="#9be0a8" stroke-width=".6" stroke-dasharray="2 2"/><path d="M-5 3 L0 -6 L5 3 Z" fill="none" stroke="#9be0a8" stroke-width="1.1"/><circle r="1.5" fill="#9be0a8"/>';
    case 'singularity': return '<circle r="12" fill="none" stroke="#f3c969" stroke-width=".7" opacity=".7"/><circle r="7" fill="#05060f" stroke="#ece9f7" stroke-width=".8"/>';
    default: return '<circle r="3" fill="#ece9f7"/>';
  }
}
function drawMap() {
  if (!S.laws || !S.uni) return;
  applyView();
  const r = R(), sel = S.sel;
  $('#L-regions').innerHTML =
    S.frontier.map((c) => `<g><rect class="frontier${sel?.kind === 'cell' && sel.gx === c.gx && sel.gy === c.gy ? ' sel' : ''}" data-gx="${c.gx}" data-gy="${c.gy}" x="${c.gx * r + 6}" y="${c.gy * r + 6}" width="${r - 12}" height="${r - 12}" rx="14"/><text class="frontier-q" x="${(c.gx + 0.5) * r}" y="${(c.gy + 0.5) * r + 10}">?</text></g>`).join('') +
    S.regions.map((g) => `<rect class="region${g.converged ? ' converged' : ''}" x="${g.gx * r + 2}" y="${g.gy * r + 2}" width="${r - 4}" height="${r - 4}" rx="16"/>${g.state === 'unstable' ? `<rect class="region-unstable" x="${g.gx * r + 2}" y="${g.gy * r + 2}" width="${r - 4}" height="${r - 4}" rx="16"/>` : ''}<text class="region-label" x="${g.gx * r + 12}" y="${g.gy * r + 18}">Region ${g.num}${g.converged ? ', converged' : ''}${g.state === 'unstable' ? ', unstable' : ''}</text>`).join('') +
    S.others.map((o, i) => { const g = S.regions.find((x) => x.id === o.region); return g ? `<text class="other-tag" x="${g.gx * r + 12}" y="${(g.gy + 1) * r - 12 - i * 10}">◌ ${esc(o.username)} is here</text>` : ''; }).join('') +
    (sel?.kind === 'point' ? `<circle class="pin" cx="${sel.x}" cy="${sel.y}" r="7"/>` : '');
  $('#L-links').innerHTML = S.rels.map((l) => { const a = S.objects.get(l.a), b = S.objects.get(l.b); return a && b ? `<line class="link" data-a="${a.id}" data-b="${b.id}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke-width="${Math.min(3, 0.6 + l.strength * 0.4)}"/>` : ''; }).join('');
  $('#L-objects').innerHTML = [...S.objects.values()].map((o) => {
    const cls = ['obj', sel?.kind === 'object' && sel.id === o.id ? 'sel' : '', S.target === o.id ? 'tgt' : '', o.stability != null && o.stability < 20 && o.type !== 'remnant' ? 'shaky' : '', !o.known && o.id === S.firstObject && S.me.knowledge === 0 ? 'first' : ''].join(' ');
    return `<g class="${cls}" data-id="${o.id}" transform="translate(${o.x} ${o.y})"><circle class="hit" r="14"/><g class="glyph">${glyph(o)}</g><circle class="ring-sel" r="13"/>${o.sig ? '<path class="sigmark" d="M8 -10 a5 5 0 0 1 5 5 M8 -14 a9 9 0 0 1 9 9"/>' : ''}${o.name ? `<text class="name" y="22">${esc(o.name)}</text>` : ''}</g>`;
  }).join('');
  planOrbits();
}

// Whatever is bonded to a star visibly circles it. This is display only: the server's
// positions are the real ones, and the orbit passes through them.
let orbits = [];
function planOrbits() {
  orbits = [];
  for (const l of S.rels) {
    const a = S.objects.get(l.a), b = S.objects.get(l.b); if (!a || !b) continue;
    const star = a.type === 'star' ? a : b.type === 'star' ? b : null, o = star === a ? b : a;
    if (!star || o.type === 'star' || o.type === 'core' || orbits.some((x) => x.id === o.id)) continue;
    const r = Math.hypot(o.x - star.x, o.y - star.y); if (r < 8) continue;
    orbits.push({ id: o.id, star, r, a0: Math.atan2(o.y - star.y, o.x - star.x), w: (2 * Math.PI) / (50 + r * 1.3),
      el: document.querySelector(`#L-objects [data-id="${o.id}"]`), lines: [...document.querySelectorAll(`#L-links [data-a="${o.id}"], #L-links [data-b="${o.id}"]`)] });
  }
  turnOrbits();
}
const t0 = Date.now();
function turnOrbits() {
  if (calm || document.hidden || S.tab !== 'universe') return;
  const t = (Date.now() - t0) / 1000;
  for (const ob of orbits) {
    const ang = ob.a0 + ob.w * t, x = ob.star.x + Math.cos(ang) * ob.r, y = ob.star.y + Math.sin(ang) * ob.r;
    ob.el?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`);
    for (const ln of ob.lines) { const end = ln.dataset.a == ob.id ? '1' : '2'; ln.setAttribute('x' + end, x.toFixed(1)); ln.setAttribute('y' + end, y.toFixed(1)); }
  }
}
setInterval(turnOrbits, 120);

function ripple(x, y, color = '#ece9f7', label) {
  const ns = 'http://www.w3.org/2000/svg';
  const c = document.createElementNS(ns, 'circle');
  c.setAttribute('class', 'ripple'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 3); c.setAttribute('stroke', color);
  $('#L-fx').append(c); setTimeout(() => c.remove(), 1600);
  if (label) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('class', 'other-tag'); t.setAttribute('x', x + 10); t.setAttribute('y', y - 10); t.textContent = label;
    $('#L-fx').append(t); setTimeout(() => t.remove(), 2600);
  }
}

// pan, pinch, wheel, tap
const ptr = new Map(); let moved = 0, pinch = 0;
map.addEventListener('pointerdown', (e) => { if (e.isPrimary) ptr.clear(); ptr.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = 0; map.setPointerCapture(e.pointerId); });
map.addEventListener('pointermove', (e) => {
  const p = ptr.get(e.pointerId); if (!p) return;
  if (ptr.size === 1) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y; moved += Math.abs(dx) + Math.abs(dy);
    if (moved > 6) { S.view.cx -= dx / S.view.k; S.view.cy -= dy / S.view.k; map.classList.add('dragging'); applyView(); }
  }
  p.x = e.clientX; p.y = e.clientY;
  if (ptr.size === 2) {
    const [a, b] = [...ptr.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoom(d / pinch); pinch = d; moved = 99;
  }
});
const up = (e) => {
  const had = ptr.delete(e.pointerId); if (ptr.size < 2) pinch = 0; map.classList.remove('dragging');
  if (had && e.type === 'pointerup' && moved <= 6 && ptr.size === 0) tap(document.elementFromPoint(e.clientX, e.clientY), e);
};
map.addEventListener('pointerup', up); map.addEventListener('pointercancel', up);
map.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
function zoom(f) { S.view.k = Math.max(0.35, Math.min(5, S.view.k * f)); applyView(); }
$('#zoomIn').onclick = () => zoom(1.3); $('#zoomOut').onclick = () => zoom(0.77);
$('#recenter').onclick = () => { const g = S.regions.find((x) => x.id === S.me.location) || S.regions[0]; Object.assign(S.view, { cx: (g.gx + 0.5) * R(), cy: (g.gy + 0.5) * R() }); fitView(); applyView(); };
addEventListener('resize', applyView);
new ResizeObserver(() => { if (S.laws && !$('#app').hidden) applyView(); }).observe(map);

function tap(el, e) {
  if (S.busy) return;
  const g = el?.closest?.('.obj');
  if (g) {
    const id = Number(g.dataset.id);
    if (S.action === 'connect' && S.sel?.kind === 'object' && S.sel.id !== id) { S.target = id; S.result = null; drawMap(); loadPoss(); return; }
    return select({ kind: 'object', id });
  }
  if (el?.classList?.contains('frontier')) return select({ kind: 'cell', gx: Number(el.dataset.gx), gy: Number(el.dataset.gy) });
  const w = toWorld(e.clientX, e.clientY), gx = Math.floor(w.x / R()), gy = Math.floor(w.y / R());
  if (S.regions.some((r) => r.gx === gx && r.gy === gy)) return select({ kind: 'point', x: Math.round(w.x), y: Math.round(w.y) });
  select(null);
}

// ---------------------------------------------------------------- selection, possibilities, acting
async function select(sel) {
  Object.assign(S, { sel, detail: null, action: null, focus: 1, amount: null, target: null, poss: null, result: null });
  const so = sel?.kind === 'object' && S.objects.get(sel.id);
  if (so) { S.view.cx = so.x; S.view.cy = so.y; }
  drawMap(); renderSheet();
  if (!sel) return;
  try {
    if (sel.kind === 'object') { await refreshDetail(); S.action = S.detail.object.level < 4 ? 'observe' : S.detail.actions.includes('touch') ? 'touch' : 'observe'; }
    if (sel.kind === 'cell') S.action = 'explore';
    if (sel.kind === 'point') S.action = 'create';
    await loadPoss();
  } catch (err) { S.error = err.message; renderSheet(); }
}
async function refreshDetail() {
  if (S.sel?.kind !== 'object') return;
  const id = S.sel.id, d = await api('/objects/' + id);
  if (S.sel?.kind === 'object' && S.sel.id === id) { S.detail = d; renderSheet(); }
}
async function loadPoss() {
  const sel = S.sel, a = S.laws.actions[S.action]; S.error = null; S.showCollapsed = false;
  if (!sel || !a) return;
  if (a.amounts && !a.amounts.includes(S.amount)) S.amount = a.amounts[1] ?? a.amounts[0];
  if (!a.focusable) S.focus = 1;
  if (a.needs === 'target' && !S.target) { S.poss = null; return renderSheet(); }
  try {
    const key = JSON.stringify([sel, S.action, S.focus, S.amount, S.target]);
    const q = new URLSearchParams({ type: S.action, focus: S.focus });
    if (a.amounts) q.set('amount', S.amount);
    if (S.target) q.set('target', S.target);
    if (sel.kind === 'cell') { q.set('gx', sel.gx); q.set('gy', sel.gy); }
    if (sel.kind === 'point') { q.set('x', sel.x); q.set('y', sel.y); }
    const p = await api((sel.kind === 'object' ? `/objects/${sel.id}` : '/universe') + '/possibilities?' + q);
    if (key !== JSON.stringify([S.sel, S.action, S.focus, S.amount, S.target])) return;
    S.poss = p.decayed ? null : p;
    if (p.decayed) S.error = 'It has decayed since you last looked.';
  } catch (err) { S.poss = null; S.error = err.message; }
  renderSheet();
}

async function act() {
  const sel = S.sel, a = S.laws.actions[S.action];
  if (S.busy || !sel || !S.poss) return;
  S.busy = true; S.error = null;
  if (S.showCollapsed) { S.showCollapsed = false; renderSheet(); }
  const btn = $('#act'); if (btn) btn.disabled = true;
  try {
    const body = { type: S.action, focus: S.focus, amount: a.amounts ? S.amount : undefined, target: S.target ?? undefined };
    const r = sel.kind === 'object' ? await api(`/objects/${sel.id}/interact`, { body }) : sel.kind === 'cell' ? await api('/universe/explore', { body: { gx: sel.gx, gy: sel.gy } }) : await api('/universe/create', { body: { x: sel.x, y: sel.y } });
    S.me = r.user; hud();
    if (r.decayed) { S.result = { narrative: r.narrative, decayed: true }; S.poss = null; await loadUniverse(); await refreshDetail().catch(() => {}); }
    else {
      S.lastInteraction = Math.max(S.lastInteraction, r.interactionId);
      const o = r.object || r.created[0], at = o ? o : sel.kind === 'point' ? sel : { x: (sel.gx + 0.5) * R(), y: (sel.gy + 0.5) * R() };
      ripple(at.x, at.y);
      await collapse(r);
      S.result = r; S.showCollapsed = true;
      S.uni.tick = r.universeTick;
      await loadUniverse();
      if (sel.kind === 'object') await refreshDetail().catch(() => {});
      renderSheet();
      $('.result')?.scrollIntoView({ block: 'nearest', behavior: calm ? 'auto' : 'smooth' });
      for (const d of r.newDiscoveries) toast(`<b>Discovery</b><span class="law">${esc(d.text)}</span>`, 'law');
      for (const e of r.events) toast(esc(e.description));
      if (r.rankUp) toast(`<b>You have changed</b><span class="law">You are now: ${esc(r.rankUp)}</span>`, 'law');
      if (r.events.length) S.lastMajor = Math.max(S.lastMajor, ...r.events.map((e) => e.id));
      // the world is different now, so the odds are too
      if (sel.kind === 'object' && S.detail && !S.detail.merged && S.detail.actions.includes(S.action)) setTimeout(() => { if (S.sel === sel && S.result === r && !S.busy) loadPoss(); }, 2600);
      else S.poss = null;
    }
  } catch (err) { S.error = err.message; }
  S.busy = false; renderSheet();
}

// The collapse: a needle sweeps the spectrum and comes to rest where the roll fell.
async function collapse(r) {
  const bar = $('.spectrum'), needle = $('.needle'); if (!bar || !needle) return;
  const ps = r.distribution.outcomes.map((o) => o.p);
  const x = (ps.slice(0, r.chosen).reduce((s, p) => s + p, 0) + ps[r.chosen] * Math.min(0.98, Math.max(0.02, r.at))) * 100;
  needle.style.opacity = 1;
  if (!calm) {
    const stops = [0, 100, 6, 88, x > 50 ? 22 : 74, x];
    await needle.animate(stops.map((v, i) => ({ left: v + '%', easing: 'cubic-bezier(.45,.05,.55,.95)', offset: [0, 0.2, 0.42, 0.62, 0.8, 1][i] })), { duration: 1700, fill: 'forwards' }).finished;
  }
  needle.style.left = x + '%';
  bar.classList.add('collapsed'); bar.children[r.chosen]?.classList.add('chosen');
  $('.legend')?.classList.add('collapsed'); $('.legend')?.children[r.chosen]?.classList.add('chosen');
  await wait(calm ? 200 : 650);
}

const pct = (p, exact) => (exact ? (p * 100 >= 10 ? Math.round(p * 100) : (p * 100).toFixed(1)) + '%' : '~' + Math.round(p * 100) + '%');
function spectrumHTML(d, chosen = -1, at = 0) {
  const done = chosen >= 0;
  const x = done ? (d.outcomes.slice(0, chosen).reduce((s, o) => s + o.p, 0) + d.outcomes[chosen].p * Math.min(0.98, Math.max(0.02, at))) * 100 : 0;
  return { bar: `<div class="spectrum${done ? ' collapsed' : ''}">${d.outcomes.map((o, i) => `<div class="segm${o.label ? '' : ' unseen'}${i === chosen ? ' chosen' : ''}" style="flex-grow:${Math.max(0.02, o.p)};flex-basis:0;background-color:${HUES[i % HUES.length]};--c:${HUES[i % HUES.length]}">${o.p >= 0.13 ? `<span>${pct(o.p, d.exact)}</span>` : ''}</div>`).join('')}<div class="needle" style="${done ? `opacity:1;left:${x}%` : ''}"></div></div>`,
    legend: `<ul class="legend${done ? ' collapsed' : ''}">${d.outcomes.map((o, i) => `<li class="${i === chosen ? 'chosen' : ''}"><i style="background:${HUES[i % HUES.length]}"></i>${o.label ? `<span>${esc(o.label)}</span>` : '<span class="unseen-t">An outcome you have not witnessed</span>'}<b>${pct(o.p, d.exact)}</b></li>`).join('')}</ul>` };
}

function renderSheet() {
  const el = $('#sheet'), sel = S.sel;
  if (!S.laws || !S.me) return;
  if (!sel) {
    const fresh = S.me.knowledge === 0;
    el.innerHTML = `<p class="hint">${fresh ? 'Something is here that you have never observed. Tap one of the dotted circles.' : 'Tap anything to see what could happen. Tap empty space to create. Tap a dashed region to give it a state.'}</p>`;
    return;
  }
  const a = S.laws.actions[S.action], r = S.result, d = S.detail, o = d?.object;
  let head = '', body = '';
  if (sel.kind === 'object') {
    if (!o) { el.innerHTML = `<p class="hint">${esc(S.error || 'Looking…')}</p>`; return; }
    const before = r?.before, delta = (k) => (r && !r.decayed && before?.[k] != null && r.object?.[k] != null && r.object[k] !== before[k] ? `<span class="delta ${r.object[k] > before[k] ? 'up' : 'down'}">${r.object[k] > before[k] ? '+' : ''}${Math.round((r.object[k] - before[k]) * 10) / 10}</span>` : '');
    const stat = (label, k, extra = '') => `<div><dt>${label}</dt><dd class="${o[k] == null ? 'unk' : ''}">${o[k] == null ? '???' : fmt(o[k])}${k === 'stability' && o[k] != null ? '%' : ''}${delta(k)}</dd>${extra}</div>`;
    const facts = [
      o.known ? `${o.state ? esc(o.state[0].toUpperCase() + o.state.slice(1)) + ', in ' : 'In '}Region ${d.regionNum ?? o.regionNum}${o.mine ? '. You made this.' : ''}` : 'You have never observed this. Its nature is unknown to you.',
      o.type === 'core' && o.energy != null ? `It ignites at ${fmt(o.threshold)} energy. ${fmt(Math.max(0, o.threshold - o.energy))} to go.` : '',
      o.was ? `It used to be a ${esc(o.was)}.` : '',
      o.origin ? esc(o.origin) : '',
      d.bonds.length ? `Bonded to ${d.bonds.map((b) => esc(b.label)).join(', ')}.` : '',
      d.otherObservers ? `${d.otherObservers} other observer${d.otherObservers === 1 ? ' has' : 's have'} interacted with this.` : '',
    ].filter(Boolean);
    head = `<div class="sheet-head"><div><h2>${esc(o.label)}</h2><p class="sub">${o.known ? esc(o.typeLabel) : 'Unobserved'}${o.complexity != null ? `, complexity ${fmt(o.complexity)}` : ''}</p></div><button class="x" data-do="close" aria-label="Close">×</button></div>
      <dl class="stats">${stat('Energy', 'energy', o.type === 'core' && o.energy != null ? `<div class="meter"><i style="width:${Math.min(100, (o.energy / o.threshold) * 100)}%"></i></div>` : '')}${stat('Stability', 'stability')}${stat('Information', 'information')}</dl>
      <div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
      <div class="chips">${d.actions.map((k) => { const x = S.laws.actions[k]; return `<button class="chip" data-do="action" data-a="${k}" aria-pressed="${k === S.action}">${esc(x.label)}<small>${x.amounts ? '' : x.cost}</small></button>`; }).join('')}</div>`;
  } else if (sel.kind === 'cell') {
    head = `<div class="sheet-head"><div><h2>${r?.region ? 'Region ' + r.region.num : 'An unexplored region'}</h2><p class="sub">${r?.region ? 'It has a state now, and a place in your map.' : 'Nobody you know of has been here. It has no state you can know until someone arrives.'}</p></div><button class="x" data-do="close" aria-label="Close">×</button></div>`;
  } else {
    head = `<div class="sheet-head"><div><h2>Empty space</h2><p class="sub">Spend energy here and something may begin to exist.</p></div><button class="x" data-do="close" aria-label="Close">×</button></div>`;
  }

  let actBtn = '';
  if (a) {
    if (a.needs === 'target' && !S.target) body += `<p class="hint" style="margin-top:12px">Now tap a second object on the map to connect it to.</p>`;
    const justCollapsed = !!(r && !r.decayed && r.action === S.action && (S.showCollapsed || !S.poss));
    const shown = justCollapsed ? r.distribution : S.poss;
    if (a.amounts && S.poss) body += `<div class="opts"><span>Amount</span>${a.amounts.map((n) => `<button class="opt" data-do="amount" data-n="${n}" aria-pressed="${n === S.amount}">${n}</button>`).join('')}</div>`;
    if (a.focusable && S.poss) body += `<div class="opts"><span>Focus</span>${[1, 2, 3].map((n) => `<button class="opt" data-do="focus" data-n="${n}" aria-pressed="${n === S.focus}">×${n}</button>`).join('')}<span>costs more, bends the odds</span></div>`;
    const blur = sel.kind === 'object' ? 'blurred until you observe it more' : 'blurred until you understand probability better';
    const sp = shown ? spectrumHTML(shown, justCollapsed ? r.chosen : -1, justCollapsed ? r.at : 0) : null;
    if (shown) body += `<div class="poss"><div class="poss-title"><span>${justCollapsed ? 'What happened' : 'What could happen'}</span><span>${shown.exact ? 'exact odds' : blur}</span></div>${sp.bar}</div>`;
    if (r) body += resultHTML(r);
    if (shown) body += sp.legend + (shown.modifiers.length ? `<ul class="why">${shown.modifiers.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : '');
    if (S.poss) actBtn = `<div class="actbar"><button class="primary act" id="act" data-do="act" ${S.busy || !S.poss.affordable ? 'disabled' : ''}><span>${esc(a.label)}${r && !r.decayed && r.action === S.action ? ' again' : ''}</span><em>${S.poss.affordable ? `${S.poss.cost} energy` : `needs ${S.poss.cost} energy`}</em></button></div>`;
  } else if (r) body += resultHTML(r);
  if (S.error) body += `<p class="error" style="margin-top:10px">${esc(S.error)}</p>`;
  if (sel.kind === 'object' && o) {
    if (o.level >= 1 && o.type !== 'remnant') {
      body += `<div class="sigs"><h3><span>Signals on this</span><button class="pill" data-do="leave">Leave a signal<small style="opacity:.6;margin-left:6px">${d.signalCosts.leave}</small></button></h3>
        ${d.signals.length ? d.signals.map((g) => `<div class="sig"><span class="glyphs">${glyphs(g.pattern)}</span><span class="t">${g.mine ? (g.isEcho ? 'your echo' : g.echoed ? 'yours, echoed by something' : 'yours, no answer yet') : g.isEcho ? 'an echo' : 'left by something'}, tick ${fmt(g.tick)}</span>${g.canEcho ? `<button class="pill go" data-do="echo" data-id="${g.id}">Echo<small style="opacity:.6;margin-left:6px">${d.signalCosts.echo}</small></button>` : '<span></span>'}</div>`).join('') : '<p class="t" style="font-size:13px;color:var(--faint)">Nothing has left a mark here.</p>'}</div>`;
    }
    body += `<div class="links">${o.level >= 2 ? `<button class="quiet" data-do="history">Why does this exist?</button>` : ''}${d.canName ? `<button class="quiet" data-do="name">Name it</button>` : ''}${o.level >= 1 ? `<button class="quiet" data-do="note">Leave a note</button>` : ''}</div>`;
  }
  const top = el.scrollTop;
  el.innerHTML = head + body + actBtn;
  el.scrollTop = top;
}
function resultHTML(r) {
  const hue = r.decayed ? '#6a6d99' : HUES[r.chosen % HUES.length];
  return `<div class="result" style="--c:${hue}"><p class="voice">${esc(r.narrative)}</p>${r.more ? `<p class="more">${esc(r.more)}</p>` : ''}
    ${r.firstTime ? `<p class="new">You had never witnessed this outcome. Knowledge +1.</p>` : ''}
    ${r.decayed ? '' : `<div class="proof"><span>Tick ${fmt(r.universeTick)}</span><span>roll ${r.roll.toFixed(4)}</span><span>seed ${esc(r.seed.slice(0, 10))}…</span><button class="quiet" data-do="verify" data-id="${r.interactionId}">Re-derive it</button><span id="proof"></span></div>`}</div>`;
}

$('#sheet').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-do]'); if (!b || S.busy) return;
  const what = b.dataset.do;
  if (what === 'close') return select(null);
  if (what === 'action') { S.action = b.dataset.a; S.target = null; S.result = null; S.poss = null; S.focus = 1; drawMap(); renderSheet(); return loadPoss(); }
  if (what === 'amount') { S.amount = Number(b.dataset.n); S.result = null; return loadPoss(); }
  if (what === 'focus') { S.focus = Number(b.dataset.n); S.result = null; return loadPoss(); }
  if (what === 'act') return act();
  if (what === 'verify') {
    try { const v = await api(`/interactions/${b.dataset.id}/verify`); $('#proof').textContent = v.ok ? 'Same state, same act, same outcome. It could not have gone otherwise.' : 'The record does not match.'; } catch (err) { $('#proof').textContent = err.message; }
    return;
  }
  if (what === 'history') return showHistory(S.sel.id);
  if (what === 'name') return openModal(`<h2>Name it</h2><p class="fine">A name is permanent. Every observer will see it.</p><form data-form="name"><input name="name" maxlength="31" autocomplete="off" required><p class="error"></p><button class="primary">Give it this name</button></form>`);
  if (what === 'leave') return pickSignal(S.sel.id);
  if (what === 'echo') return echo(Number(b.dataset.id));
  if (what === 'note') return openModal(`<h2>Leave a note</h2><p class="fine">Words give you away, so only you and observers you have found can read notes.</p><form data-form="note"><textarea name="body" rows="3" maxlength="280" required></textarea><p class="error"></p><button class="primary">Leave the note</button></form>`);
});

async function showHistory(id) {
  try {
    const h = await api(`/objects/${id}/history`);
    const origin = h.createdBy ? `Created by ${esc(h.createdBy)}` : h.foundBy ? `Given a state when ${esc(h.foundBy)} explored its region` : h.parent ? `It came from ${esc(h.parent.label)}` : 'It was here before any observer';
    openModal(`<h2>Why does this exist?</h2><p class="sub" style="color:var(--dim)">${esc(h.label)}, ${fmt(h.age)} ticks old</p>
      <ul class="rows">
        <li><span>${origin}, at tick ${fmt(h.createdTick)}.</span></li>
        ${h.origin ? `<li><q>${esc(h.origin)}</q></li>` : ''}
        ${h.forms.map((f) => `<li><span>It changed from ${esc(f.from)} to ${esc(f.to)}.</span><span class="t">tick ${fmt(f.tick)}</span></li>`).join('')}
        <li><span>${fmt(h.totals.interactions)} interaction${h.totals.interactions === 1 ? '' : 's'} by ${fmt(h.totals.observers)} observer${h.totals.observers === 1 ? '' : 's'} made it what it is.${h.namedBy ? ` Named by ${esc(h.namedBy)}.` : ''}</span></li>
      </ul>
      ${h.notes.length ? `<h3>Notes</h3><ul class="rows">${h.notes.map((n) => `<li><q>${esc(n.body)}</q><span class="t">${esc(n.username)}, tick ${fmt(n.tick)}</span></li>`).join('')}</ul>` : ''}
      <h3>Its record</h3>
      ${h.interactions.length ? `<ul class="rows">${h.interactions.map((i) => `<li><span>${esc(i.observer)} ${esc(i.verb)} it. ${esc(i.outcome)}.</span><span class="t">tick ${fmt(i.tick)}</span></li>`).join('')}</ul>` : '<p class="empty">Nobody has interacted with it yet.</p>'}
      <button class="primary" data-close>Close</button>`);
  } catch (err) { toast(esc(err.message)); }
}

// ---------------------------------------------------------------- overlays
function openModal(html) { const m = $('#modal'); m.innerHTML = `<div class="modal-card">${html}</div>`; m.hidden = false; (m.querySelector('input,textarea') || m.querySelector('button'))?.focus({ preventScroll: true }); m.firstChild.scrollTop = 0; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) $('#modal').hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });
$('#modal').addEventListener('submit', async (e) => {
  const f = e.target; if (!f.dataset.form) return;
  e.preventDefault(); const id = S.sel?.id;
  try {
    if (f.dataset.form === 'name') await api(`/objects/${id}/name`, { body: { name: f.name.value } });
    if (f.dataset.form === 'note') await api(`/objects/${id}/notes`, { body: { body: f.body.value } });
    $('#modal').hidden = true; await loadUniverse(); await refreshDetail();
    toast(f.dataset.form === 'name' ? 'It has a name now.' : 'Your note is part of its record.');
  } catch (err) { f.querySelector('.error').textContent = err.message; }
});
function toast(html, cls = '') { const t = document.createElement('div'); t.className = 'toast ' + cls; t.innerHTML = html; $('#toasts').append(t); setTimeout(() => t.remove(), 7200); }

// ---------------------------------------------------------------- the other sections
document.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
async function showTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tabs button').forEach((b) => (b.dataset.tab === tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  for (const t of ['universe', 'discover', 'history', 'signals', 'profile']) $('#view-' + t).hidden = t !== tab;
  if (tab === 'signals') $('#sigDot').hidden = true;
  if (tab === 'universe') { applyView(); return; }
  const el = $('#view-' + tab);
  try { await ({ discover, history, signals, profile }[tab])(el); } catch (err) { el.innerHTML = `<p class="empty">${esc(err.message)}</p>`; }
}
async function discover(el) {
  const [mine, all] = await Promise.all([api('/users/me/discoveries'), api('/discoveries')]);
  const laws = mine.discoveries.filter((d) => d.type === 'law'), firsts = mine.discoveries.filter((d) => d.type === 'first');
  el.innerHTML = `<h2>What you have learned</h2><p class="lede">Knowledge is not points. It is the set of relationships you have found by experiment. None of it is guaranteed to be true.</p>
    <div>${mine.domains.map((d) => `<div class="domain"><span>${esc(d.key[0].toUpperCase() + d.key.slice(1))}</span><div class="bar"><i style="width:${Math.min(100, ((d.points - 3 * d.level ** 2) / (3 * (d.level + 1) ** 2 - 3 * d.level ** 2)) * 100)}%"></i></div><b>Level ${d.level}</b></div>`).join('')}</div>
    <h3>Your hypotheses, ${mine.lawsFound} of ${mine.lawsTotal}</h3>
    ${laws.length ? `<ul class="rows">${laws.map((d) => `<li><q>${esc(d.description)}</q><span class="t">found at tick ${fmt(d.tick)}</span></li>`).join('')}</ul>` : '<p class="empty">You have not found a rule yet. Do the same thing to different objects and watch what differs.</p>'}
    <p class="fine" style="margin-top:12px">You have witnessed ${mine.witnessed} of ${mine.possibleOutcomes} possible outcomes.</p>
    ${firsts.length ? `<h3>Firsts</h3><ul class="rows">${firsts.map((d) => `<li><span>${esc(d.description)}</span><span class="t">tick ${fmt(d.tick)}</span></li>`).join('')}</ul>` : ''}
    <h3>Found by other observers</h3>
    ${all.discoveries.filter((d) => !d.mine).length ? `<ul class="rows">${all.discoveries.filter((d) => !d.mine).slice(0, 15).map((d) => `<li><span>${esc(d.username)} found something${d.type === 'first' ? ': ' + esc(d.description) : '. You will have to find it yourself.'}</span><span class="t">tick ${fmt(d.tick)}</span></li>`).join('')}</ul>` : '<p class="empty">Nobody else has reported anything yet.</p>'}`;
}
// ---- signals, contact, speech
function pickSignal(objectId) {
  const picked = [];
  const draw = () => {
    $('#slots').innerHTML = [0, 1, 2].map((i) => `<span>${picked[i] != null ? GLYPHS[picked[i]] : ''}</span>`).join('');
    $('#sendSig').disabled = picked.length < 3;
  };
  openModal(`<h2>Leave a signal</h2><p class="fine">Three glyphs, no words. Anything that observes this object will see them. Nothing will tell it who left them, and nothing will tell you who answers.</p>
    <div class="slots" id="slots"></div><div class="picker">${GLYPHS.map((g, i) => `<button type="button" data-g="${i}" aria-label="glyph ${i + 1}">${g}</button>`).join('')}</div>
    <p class="error" id="sigErr"></p><button class="primary" id="sendSig" disabled>Leave it here</button><p style="text-align:center;margin-top:8px"><button class="quiet" id="clearSig" type="button">Start again</button></p>`);
  draw();
  $('.picker').onclick = (e) => { const b = e.target.closest('[data-g]'); if (b && picked.length < 3) { picked.push(Number(b.dataset.g)); draw(); } };
  $('#clearSig').onclick = () => { picked.length = 0; draw(); };
  $('#sendSig').onclick = async () => {
    try {
      const r = await api(`/objects/${objectId}/signal`, { body: { pattern: picked.join('') } });
      $('#modal').hidden = true; S.me.energy = r.energy; hud(); toast(esc(r.narrative));
      for (const d of r.newDiscoveries) toast(`<b>Discovery</b><span class="law">${esc(d.text)}</span>`, 'law');
      await loadUniverse(); await refreshDetail().catch(() => {});
    } catch (err) { $('#sigErr').textContent = err.message; }
  };
}
async function echo(signalId) {
  try {
    const r = await api(`/signals/${signalId}/echo`, { body: {} });
    S.me.energy = r.energy; hud();
    if (r.contact) { toast(`<b>Contact</b><span class="law">${esc(r.narrative)}</span>`, 'law'); if (S.social) S.social.contact = Math.max(S.social.contact, r.contact.id); }
    else toast(esc(r.narrative));
    for (const d of r.newDiscoveries) toast(`<b>Discovery</b><span class="law">${esc(d.text)}</span>`, 'law');
    await loadUniverse();
    if (S.tab === 'signals') signals($('#view-signals')); else await refreshDetail().catch(() => {});
    if (r.contact) openChat(r.contact.id, r.contact.username);
  } catch (err) { toast(esc(err.message)); }
}
async function signals(el) {
  const d = await api('/signals');
  el.innerHTML = `<h2>Signals</h2><p class="lede">You cannot see other observers and they cannot see you. Leave three glyphs on something. If an echo comes back, answer it. Only then will you know whether it was someone.</p>
    <h3>Observers you have found</h3>
    ${d.contacts.length ? d.contacts.map((c) => `<button class="contact" data-chat="${c.id}" data-name="${esc(c.username)}"><b>${esc(c.username)}</b><span class="t" style="grid-column:2;grid-row:1 / span 2;color:var(--ice)">Speak</span><span>${c.last ? (c.last.mine ? 'You: ' : '') + esc(c.last.body) : 'Found at tick ' + fmt(c.sinceTick) + '. Nothing said yet.'}</span></button>`).join('') : '<p class="empty">Nobody yet. You may be alone here. You may not.</p>'}
    <h3>Signals you have left</h3>
    ${d.signals.length ? `<ul class="rows">${d.signals.map((g) => `<li><div class="sig"><span class="glyphs">${glyphs(g.pattern)}</span><span class="t">on ${esc(g.object)}, tick ${fmt(g.tick)}<br>${g.openEcho ? 'Something echoed it.' : g.echoes ? 'Echoed. You answered. Nothing more came back.' : 'No answer.'}</span>${g.openEcho ? `<button class="pill go" data-answer="${g.openEcho}">Answer<small style="opacity:.6;margin-left:6px">${d.costs.echo}</small></button>` : '<span></span>'}</div></li>`).join('')}</ul>` : '<p class="empty">You have not left a signal. Observe something, then leave one on it.</p>'}`;
  el.onclick = (e) => {
    const a = e.target.closest('[data-answer]'); if (a) return echo(Number(a.dataset.answer));
    const c = e.target.closest('[data-chat]'); if (c) openChat(Number(c.dataset.chat), c.dataset.name);
  };
}
let chatTimer = null;
async function openChat(id, name) {
  let last = 0;
  openModal(`<h2>${esc(name)}</h2><p class="fine">You found each other. What you say here is only between you.</p><div class="chat" id="chat"></div>
    <form class="chatbar" id="chatForm"><textarea name="body" rows="1" maxlength="500" placeholder="Say something" required></textarea><button class="primary">Send</button></form><p class="error" id="chatErr"></p>`);
  const load = async () => {
    if ($('#modal').hidden || !$('#chat')) return clearInterval(chatTimer);
    try {
      const d = await api(`/contacts/${id}/messages?after=${last}`); const box = $('#chat'); if (!box) return;
      for (const m of d.messages) { const p = document.createElement('p'); if (m.mine) p.className = 'mine'; p.textContent = m.body; const t = document.createElement('small'); t.textContent = 'tick ' + fmt(m.tick); p.append(t); box.append(p); last = m.id; }
      if (d.messages.length) box.scrollTop = box.scrollHeight;
      if (!box.children.length && !box.dataset.empty) { box.dataset.empty = '1'; box.innerHTML = '<span class="empty" style="padding:6px 0">Nothing has been said yet.</span>'; }
      else if (d.messages.length && box.dataset.empty) { box.querySelector('.empty')?.remove(); delete box.dataset.empty; }
      if (S.social && last > S.social.message) S.social.message = last;
    } catch {}
  };
  await load(); clearInterval(chatTimer); chatTimer = setInterval(load, 4000);
  $('#chatForm').onsubmit = async (e) => {
    e.preventDefault(); const f = e.target, body = f.body.value.trim(); if (!body) return;
    try { await api(`/contacts/${id}/messages`, { body: { body } }); f.body.value = ''; $('#chatErr').textContent = ''; await load(); } catch (err) { $('#chatErr').textContent = err.message; }
  };
}

let historyMode = 'feed';
async function history(el) {
  const seg = `<div class="seg" style="margin-bottom:10px">${[['feed', 'Reality feed'], ['all', 'Every interaction'], ['mine', 'Yours']].map(([k, l]) => `<button data-h="${k}" aria-selected="${k === historyMode}">${l}</button>`).join('')}</div>`;
  let rows = '';
  if (historyMode === 'feed') {
    const f = await api('/universe/feed');
    rows = f.events.map((e) => `<li><span class="${e.impact === 'cosmic' ? 'cosmic' : ''}">${esc(e.description)}</span><span class="t">tick ${fmt(e.tick)}${e.region ? `, Region ${e.region}` : ''}</span></li>`).join('');
  } else {
    const t = await api('/timeline' + (historyMode === 'mine' ? '?mine=1' : ''));
    rows = t.interactions.map((i) => `<li><span>${i.mine ? 'You' : esc(i.observer)} ${esc(i.verb)} ${esc(i.object)}. ${esc(i.outcome)}.</span><span class="t">tick ${fmt(i.tick)}${i.spent ? `, ${i.spent} energy` : ''}</span></li>`).join('');
  }
  el.innerHTML = `<h2>The universe remembers</h2><p class="lede">Nothing in this record can be changed or removed.</p>${seg}${rows ? `<ul class="rows">${rows}</ul>` : '<p class="empty">Nothing here yet. Go and cause something.</p>'}`;
  el.querySelectorAll('[data-h]').forEach((b) => (b.onclick = () => { historyMode = b.dataset.h; history(el); }));
}
async function profile(el) {
  const p = await api('/users/me'), l = p.life, ranks = ['Unknown Observer', 'Explorer', 'Interactor', 'Creator', 'Architect', 'Cosmic Observer'];
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  el.innerHTML = `<h2>${esc(p.user.username)}</h2><p class="lede">Your life. There is only this one.</p>
    <p class="ladder">${ranks.map((r) => (r === p.user.rank ? `<b>${r}</b>` : `<span>${r}</span>`)).join('<span>›</span>')}</p>
    <dl class="life" style="margin-top:14px">
      ${row('Universe age when you arrived', fmt(l.arrivedTick))}${row('Universe age now', fmt(l.currentTick))}
      ${row('Interactions', fmt(l.interactions))}${row('Discoveries', fmt(l.discoveries))}${row('Regions given a place in your map', fmt(l.regionsExplored))}
      ${row('Objects created', fmt(l.objectsCreated))}${row('Objects influenced', fmt(l.objectsInfluenced))}${row('Major events you caused', fmt(l.majorEvents))}
      ${row('Other observers affected', fmt(l.observersAffected))}
      ${row('Your oldest surviving creation', l.oldestCreation ? `${esc(l.oldestCreation.label)}, ${fmt(l.oldestCreation.age)} ticks` : 'None yet')}
      ${p.user.observedBy ? row('Something observed you', 'tick ' + fmt(p.user.observedBy)) : ''}
    </dl>
    <p class="fine" style="margin-top:16px">Energy returns slowly from the vacuum, one every ${S.laws.regenSeconds} seconds up to ${S.laws.regenCap}. To hold more, draw it from the universe.</p>
    <p style="margin-top:18px"><button class="quiet" id="out">Sign out</button></p>`;
  $('#out', el).onclick = signOut;
}

// ---------------------------------------------------------------- begin
if (S.token) enter(null).catch(() => showGate()); else showGate();

// Installable web app: register the service worker (needs https or localhost).
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
