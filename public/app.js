import { attachGestures } from './gesture.js';

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
  sel: null, detail: null, action: null, focus: 1, amount: null, target: null, poss: null, result: null, busy: false, firstObject: null, pos: new Map(), focusId: null, last: null,
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
  fitView(); drawMap();
  say(S.me.gestures.length ? 'The universe kept moving while you were gone.' : 'Something is here that you have never observed. Tap one of the dotted circles.');
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
    const quiet = !queued;
    if (p.lastInteraction === S.lastInteraction && quiet && (p.lastMajorEvent !== S.lastMajor || ++pulses % 5 === 0)) await loadUniverse();
    if (p.lastInteraction !== S.lastInteraction) {
      S.lastInteraction = p.lastInteraction;
      await loadUniverse();
      if (S.sel?.kind === 'object') refreshDetail().catch(() => {});
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
    const cls = ['obj', (sel?.kind === 'object' ? sel.id : S.focusId) === o.id ? 'sel' : '', o.stability != null && o.stability < 20 && o.type !== 'remnant' ? 'shaky' : '', !o.known && o.id === S.firstObject && S.me.knowledge === 0 ? 'first' : ''].join(' ');
    return `<g class="${cls}" data-id="${o.id}" transform="translate(${o.x} ${o.y})"><circle class="hit" r="14"/><g class="glyph">${glyph(o)}</g><circle class="ring-sel" r="13"/>${o.sig ? '<path class="sigmark" d="M8 -10 a5 5 0 0 1 5 5 M8 -14 a9 9 0 0 1 9 9"/>' : ''}${o.name ? `<text class="name" y="22">${esc(o.name)}</text>` : ''}</g>`;
  }).join('');
  planOrbits();
}

// Whatever is bonded to a star visibly circles it. This is display only: the server's
// positions are the real ones, and the orbit passes through them.
let orbits = [];
function planOrbits() {
  orbits = []; S.pos.clear();
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
    ob.el?.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`); S.pos.set(ob.id, { x, y });
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

// ---------------------------------------------------------------- moving the view
function zoom(f, px, py) {
  const k = Math.max(0.35, Math.min(5, S.view.k * f));
  if (px != null) { const w = toWorld(px, py); S.view.cx = w.x - (w.x - S.view.cx) * (S.view.k / k); S.view.cy = w.y - (w.y - S.view.cy) * (S.view.k / k); }
  S.view.k = k; applyView();
}
$('#zoomIn').onclick = () => zoom(1.3); $('#zoomOut').onclick = () => zoom(0.77);
$('#recenter').onclick = () => { const g = S.regions.find((x) => x.id === S.me.location) || S.regions[0]; Object.assign(S.view, { cx: (g.gx + 0.5) * R(), cy: (g.gy + 0.5) * R() }); fitView(); applyView(); };
$('#studyBtn').onclick = () => study(null);
addEventListener('resize', applyView);
new ResizeObserver(() => { if (S.laws && !$('#app').hidden) applyView(); }).observe(map);

// ---------------------------------------------------------------- GestureManager
// Tells the recognizer what is under the hand, draws the hand's trace, and turns
// each recognised gesture into an action. There are no action buttons.
const wrap = () => $('.mapwrap').getBoundingClientRect();
const toScreen = (x, y) => { const b = map.getBoundingClientRect(); return { x: b.left + b.width / 2 + (x - S.view.cx) * S.view.k, y: b.top + b.height / 2 + (y - S.view.cy) * S.view.k }; };
const shown = (o) => S.pos.get(o.id) || o;                         // where an object is drawn (orbiters move)
const objScreen = (id) => { const o = S.objects.get(id); return o ? toScreen(shown(o).x, shown(o).y) : null; };
const targetScreen = (t) => (t.kind === 'object' ? objScreen(t.id) || { x: t.sx, y: t.sy } : t.kind === 'frontier' ? toScreen((t.gx + 0.5) * R(), (t.gy + 0.5) * R()) : toScreen(t.x, t.y));
const inPolygon = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c; } return c; };

const host = {
  hit(px, py) {
    let best = null, bd = 28;
    for (const o of S.objects.values()) { const s = toScreen(shown(o).x, shown(o).y), d = Math.hypot(s.x - px, s.y - py); if (d < bd) { bd = d; best = o; } }
    if (best) { const s = objScreen(best.id); return { kind: 'object', id: best.id, sx: s.x, sy: s.y }; }
    const w = toWorld(px, py), gx = Math.floor(w.x / R()), gy = Math.floor(w.y / R());
    if (S.regions.some((r) => r.gx === gx && r.gy === gy)) return { kind: 'space', x: Math.round(w.x), y: Math.round(w.y) };
    if (S.frontier.some((c) => c.gx === gx && c.gy === gy)) return { kind: 'frontier', gx, gy };
    return { kind: 'void' };
  },
  enclosed(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let best = null, bd = 1e9;
    for (const o of S.objects.values()) { const s = toScreen(shown(o).x, shown(o).y); if (!inPolygon(s, pts)) continue; const d = Math.hypot(s.x - cx, s.y - cy); if (d < bd) { bd = d; best = { kind: 'object', id: o.id, sx: s.x, sy: s.y }; } }
    return best;
  },
  near(pts) {
    let best = null, bd = 30;
    for (const o of S.objects.values()) { const s = toScreen(shown(o).x, shown(o).y); for (const p of pts) { const d = Math.hypot(s.x - p.x, s.y - p.y); if (d < bd) { bd = d; best = { kind: 'object', id: o.id, sx: s.x, sy: s.y }; } } }
    return best;
  },
  wantsThird(t) { const o = S.objects.get(t.id); return !!o && ['replicator', 'organism', 'ecosystem', 'intelligence', 'anomaly'].includes(o.type); },
  onPan(dx, dy) { S.view.cx -= dx / S.view.k; S.view.cy -= dy / S.view.k; applyView(); },
  onZoom: zoom,
  onTrail(pts, from) {
    const ink = $('#trail'), b = wrap();
    if (!pts) { ink.setAttribute('points', ''); return; }
    ink.setAttribute('points', pts.slice(-160).map((p) => `${(p.x - b.left).toFixed(0)},${(p.y - b.top).toFixed(0)}`).join(' '));
    ink.classList.toggle('from', !!from);
  },
  onHover(t) { const h = $('#hover'); if (!t) return h.setAttribute('r', 0); const s = targetScreen(t), b = wrap(); h.setAttribute('cx', s.x - b.left); h.setAttribute('cy', s.y - b.top); h.setAttribute('r', 20); },
  onCharge(c) {
    const ring = $('#charge'), arc = $('#chargeArc'), label = $('#chargeLabel'), b = wrap();
    if (!c) { ring.setAttribute('r', 0); arc.setAttribute('r', 0); label.textContent = ''; return; }
    const s = targetScreen(c.target), x = s.x - b.left, y = s.y - b.top, r = 26, C = 2 * Math.PI * r;
    let f = 0, text = '', cls = '';
    if (c.kind === 'confirm') { f = Math.min(1, c.ms / c.total); cls = 'danger'; }
    else if (c.kind === 'spread') { f = c.ms; cls = 'cool'; }
    else if (c.target.kind === 'object') { const st = chargeStage(c.ms); f = st.progress; text = String(st.amount); }
    else { const total = c.target.kind === 'frontier' ? HOLD.explore : HOLD.create; f = Math.min(1, c.ms / total); cls = 'cool'; }
    for (const el of [ring, arc]) { el.setAttribute('cx', x); el.setAttribute('cy', y); el.setAttribute('r', r); }
    arc.setAttribute('class', 'charge-arc ' + cls); arc.setAttribute('stroke-dasharray', `${f * C} ${C}`); arc.setAttribute('transform', `rotate(-90 ${x} ${y})`);
    label.setAttribute('x', x); label.setAttribute('y', y - 40); label.textContent = text;
  },
  onGesture: (g) => resolve(g),
};
attachGestures(map, host);

// Holding longer gives more. Practice with the gesture unlocks longer holds.
const HOLD = { create: 1200, explore: 750, stages: [450, 1100, 2100, 3400, 5000] };
function chargeStage(ms) {
  const lvl = S.me.gestures.find((g) => g.key === 'energize')?.level || 0;
  const amounts = [5, 15, 40, ...(lvl >= 3 ? [80] : []), ...(lvl >= 5 ? [160] : [])];
  let i = 0; while (i + 1 < amounts.length && ms >= HOLD.stages[i + 1]) i++;
  const next = HOLD.stages[i + 1], prev = HOLD.stages[i];
  return { amount: amounts[i], progress: i + 1 < amounts.length ? Math.min(1, (ms - prev) / (next - prev)) : 1 };
}

// Gesture -> action. This table is the whole control scheme.
function resolve(g) {
  const t = g.target;
  if (g.type === 'twoTap') return study(t);
  if (g.type === 'miss') { if (g.len > 140 && !S.toldPan && S.me.knowledge > 0) { S.toldPan = true; say('Two fingers move the map. One finger acts on it.'); } return; }
  if (!$('#sheet').hidden && g.type === 'tap' && t.kind !== 'object') return closeStudy();
  const obj = t.kind === 'object' ? { objectId: t.id } : null;
  switch (g.type) {
    case 'tap': if (obj) return perform('observe', obj, t); if (t.kind === 'frontier') return ghost('flick', t); return;
    case 'double': return obj && perform('touch', obj, t);
    case 'triple': return obj && perform('signal', obj, t);
    case 'hold':
      if (obj) return perform('energize', { ...obj, amount: chargeStage(g.ms).amount }, t);
      if (t.kind === 'space' && g.ms >= HOLD.create) return perform('create', { x: t.x, y: t.y }, t);
      if (t.kind === 'frontier' && g.ms >= HOLD.explore) return perform('explore', { gx: t.gx, gy: t.gy }, t);
      return;
    case 'swipe': return g.shift ? perform('separate', obj, t) : perform('draw', { ...obj, amount: g.len < 95 ? 5 : g.len < 180 ? 15 : 40 }, t);
    case 'drag': return perform('connect', { ...obj, target: g.onto.id }, g.onto);
    case 'spread': return perform('separate', obj, t);
    case 'circle': return perform('stabilize', obj, t);
    case 'scribble': return perform('unmake', obj, t);
    case 'flick': return perform('explore', { gx: t.gx, gy: t.gy }, t);
  }
}

// ---------------------------------------------------------------- ActionExecutionPipeline
// gesture -> server decides -> mastery and discovery -> feedback at the point of contact -> world reloads
let chain = Promise.resolve(), queued = 0;
function perform(type, args, target) {
  if (queued >= 4) return;
  queued++; ripple(...Object.values(toWorldOf(target)));
  chain = chain.then(() => run(type, args, target)).finally(() => queued--);
}
const toWorldOf = (t) => (t.kind === 'object' ? (() => { const o = S.objects.get(t.id); return o ? { x: shown(o).x, y: shown(o).y } : { x: 0, y: 0 }; })() : t.kind === 'frontier' ? { x: (t.gx + 0.5) * R(), y: (t.gy + 0.5) * R() } : { x: t.x, y: t.y });
async function run(type, args, target) {
  S.busy = true;
  try {
    const r = args.objectId ? await api(`/objects/${args.objectId}/interact`, { body: { type, amount: args.amount, target: args.target } })
      : type === 'explore' ? await api('/universe/explore', { body: { gx: args.gx, gy: args.gy } }) : await api('/universe/create', { body: { x: args.x, y: args.y } });
    S.me = r.user; hud();
    if (r.decayed) { say(r.narrative); await loadUniverse(); return; }
    S.lastInteraction = Math.max(S.lastInteraction, r.interactionId);
    S.uni.tick = r.universeTick;
    const focusId = args.target && type === 'connect' ? args.objectId : args.objectId ?? r.created[0]?.id ?? null;
    if (focusId) S.focusId = focusId;
    S.last = { ...r, objectId: args.objectId ?? null };
    probabilityPulse(target, r);
    voice(r);
    if (r.firstGesture) { toast(`<b>${esc(r.firstGesture.name)}</b><span class="law">${esc(r.firstGesture.text)}</span><span class="t">Knowledge +1</span>`, 'law'); if (S.tab === 'discover') discover($('#view-discover')); }
    if (r.masteryUp) toast(`<b>Practice</b><span class="law">${esc(r.masteryUp.name)} has reached level ${r.masteryUp.level}.</span>`, 'law');
    for (const d of r.newDiscoveries) toast(`<b>Discovery</b><span class="law">${esc(d.text)}</span>`, 'law');
    for (const e of r.events) toast(esc(e.description));
    if (r.rankUp) toast(`<b>You have changed</b><span class="law">You are now: ${esc(r.rankUp)}</span>`, 'law');
    if (r.events.length) S.lastMajor = Math.max(S.lastMajor, ...r.events.map((e) => e.id));
    await loadUniverse();
    if (S.sel) { if (S.sel.kind === 'object') await refreshDetail().catch(() => {}); loadPoss(); }
  } catch (err) { failPulse(target, err.message); }
  finally { S.busy = false; }
}

// ---------------------------------------------------------------- ContextualProbabilityFeedback
// The odds appear where the hand was: a ring of every outcome, a needle that spins
// and lands where the roll fell, and the name of what happened. Then it fades.
function place(el, target) {
  const s = targetScreen(target), b = wrap();
  el.style.left = Math.max(56, Math.min(b.width - 56, s.x - b.left)) + 'px';
  el.style.top = Math.max(56, Math.min(b.height - 74, s.y - b.top)) + 'px';
  $('#fx').append(el);
}
function probabilityPulse(target, r) {
  const el = document.createElement('div'); el.className = 'pulse';
  const R0 = 34, C = 2 * Math.PI * R0, d = r.distribution;
  let acc = 0;
  const arcs = d.outcomes.map((o, i) => { const a = `<circle class="arc${i === r.chosen ? ' chosen' : ''}${o.label ? '' : ' unseen'}" cx="46" cy="46" r="${R0}" stroke="${HUES[i % HUES.length]}" stroke-dasharray="${Math.max(0, o.p * C - 2)} ${C}" stroke-dashoffset="${-acc * C}"/>`; acc += o.p; return a; }).join('');
  const before = d.outcomes.slice(0, r.chosen).reduce((s, o) => s + o.p, 0), deg = (before + d.outcomes[r.chosen].p * Math.min(0.95, Math.max(0.05, r.at))) * 360;
  el.innerHTML = `<svg viewBox="0 0 92 92"><g transform="rotate(-90 46 46)">${arcs}</g><g class="spin"><line x1="46" y1="46" x2="46" y2="6"/><circle cx="46" cy="6" r="3.2"/></g></svg>
    <div class="cap"><b>${esc(r.outcomeLabel)}</b><span>${pct(d.outcomes[r.chosen].p, d.exact)}</span></div>`;
  place(el, target);
  const spin = el.querySelector('.spin');
  const land = () => { spin.style.transform = `rotate(${deg}deg)`; el.classList.add('done'); };
  if (calm) land(); else spin.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${720 + deg}deg)` }], { duration: 850, easing: 'cubic-bezier(.15,.6,.2,1)' }).finished.then(land);
  setTimeout(() => el.classList.add('out'), 2300); setTimeout(() => el.remove(), 2800);
}
function failPulse(target, message) {
  const el = document.createElement('div'); el.className = 'pulse fail'; el.innerHTML = `<div class="cap"><b>${esc(message)}</b></div>`;
  place(el, target); setTimeout(() => el.classList.add('out'), 1900); setTimeout(() => el.remove(), 2400);
}
// The line at the bottom: what the universe just said.
function say(text) { $('#voice').innerHTML = `<p class="hint">${esc(text)}</p>`; }
function voice(r) {
  const d = r.energyDelta, bits = [
    d ? `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d} energy</span>` : '',
    r.firstTime ? '<span class="new">a new outcome, knowledge +1</span>' : '',
  ].filter(Boolean).join('');
  $('#voice').innerHTML = `<p class="voice">${esc(r.narrative)}</p>${r.more ? `<p class="more">${esc(r.more)}</p>` : ''}${bits ? `<p class="bits">${bits}</p>` : ''}`;
}
$('#voice').onclick = () => study(null);

// Ghost traces: now and then the universe shows a motion, never what it does.
const GHOSTS = [['touch', 'double'], ['energize', 'hold'], ['explore', 'flick'], ['draw', 'swipe'], ['connect', 'drag'], ['create', 'holdEmpty'], ['stabilize', 'circle'], ['unmake', 'scribble']];
function ghost(kind, t) {
  if (calm) return;
  const b = wrap(), s = targetScreen(t), x = s.x - b.left, y = s.y - b.top, ns = 'http://www.w3.org/2000/svg';
  const add = (tag, attrs, cls) => { const el = document.createElementNS(ns, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); el.setAttribute('class', 'ghost ' + cls); $('#ink').append(el); setTimeout(() => el.remove(), 2600); return el; };
  if (kind === 'double') { add('circle', { cx: x, cy: y, r: 16 }, 'g-pop'); setTimeout(() => add('circle', { cx: x, cy: y, r: 16 }, 'g-pop'), 260); }
  else if (kind === 'hold' || kind === 'holdEmpty') add('circle', { cx: x, cy: y, r: 24 }, 'g-swell');
  else if (kind === 'circle') add('circle', { cx: x, cy: y, r: 30, pathLength: 100 }, 'g-draw');
  else if (kind === 'swipe') add('path', { d: `M${x} ${y} l70 -46`, pathLength: 100 }, 'g-draw');
  else if (kind === 'scribble') add('path', { d: `M${x - 30} ${y - 14} l60 8 l-60 8 l60 8 l-60 8`, pathLength: 100 }, 'g-draw');
  else if (kind === 'drag') { const o = [...S.objects.values()].filter((o) => o.id !== t.id).map((o) => ({ o, s: toScreen(shown(o).x, shown(o).y) })).sort((a, c) => Math.hypot(a.s.x - s.x, a.s.y - s.y) - Math.hypot(c.s.x - s.x, c.s.y - s.y))[0]; if (o) add('path', { d: `M${x} ${y} L${o.s.x - b.left} ${o.s.y - b.top}`, pathLength: 100 }, 'g-draw'); }
  else if (kind === 'flick') { const c = toScreen(S.view.cx, S.view.cy); const near = S.regions.map((g) => toScreen((g.gx + 0.5) * R(), (g.gy + 0.5) * R())).sort((a, c2) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(c2.x - s.x, c2.y - s.y))[0] || c; add('path', { d: `M${near.x - b.left + (s.x - near.x) * 0.45} ${near.y - b.top + (s.y - near.y) * 0.45} L${x} ${y}`, pathLength: 100 }, 'g-draw'); }
}
setInterval(() => {
  if (!S.me || S.tab !== 'universe' || document.hidden || S.busy || !$('#sheet').hidden || !$('#modal').hidden) return;
  const known = new Set(S.me.gestures.map((g) => g.key));
  if (!known.has('observe') || (S.me.gestures.find((g) => g.key === 'observe')?.uses || 0) < 3) return;
  const next = GHOSTS.find(([a]) => !known.has(a) && (a !== 'unmake' || known.size >= 5)); if (!next) return;
  const b = wrap(), onScreen = (s) => s.x > b.left + 30 && s.x < b.right - 30 && s.y > b.top + 30 && s.y < b.bottom - 30;
  if (next[1] === 'flick') { const c = S.frontier.find((c) => onScreen(toScreen((c.gx + 0.5) * R(), (c.gy + 0.5) * R()))); return c && ghost('flick', { kind: 'frontier', gx: c.gx, gy: c.gy }); }
  if (next[1] === 'holdEmpty') { const w = toWorld(b.left + b.width * 0.5, b.top + b.height * 0.3); return host.hit(b.left + b.width * 0.5, b.top + b.height * 0.3).kind === 'space' && ghost('holdEmpty', { kind: 'space', x: w.x, y: w.y }); }
  const pick = [...S.objects.values()].filter((o) => o.type !== 'remnant' && onScreen(toScreen(shown(o).x, shown(o).y)));
  if (pick.length) ghost(next[1], { kind: 'object', id: pick[Math.floor(Math.random() * pick.length)].id });
}, 21000);

// Desktop: S studies the last thing you acted on, arrows move the map, + and - zoom.
addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea') || !$('#modal').hidden || S.tab !== 'universe' || !S.me) return;
  const step = 60 / S.view.k;
  if (e.key === 's' || e.key === 'S') study(null);
  else if (e.key === 'Escape') closeStudy();
  else if (e.key === 'ArrowLeft') host.onPan(60, 0); else if (e.key === 'ArrowRight') host.onPan(-60, 0);
  else if (e.key === 'ArrowUp') host.onPan(0, 60); else if (e.key === 'ArrowDown') host.onPan(0, -60);
  else if (e.key === '+' || e.key === '=') zoom(1.2); else if (e.key === '-') zoom(0.83);
  void step;
});

// ---------------------------------------------------------------- the Study Sheet
// Secondary. Exact odds, statistics, history, signals. Nothing here is needed to play.
const HOW = {
  observe: 'Tap it.', touch: 'Double tap it.', energize: 'Press and hold on it. Longer gives more.', draw: 'Swipe away from it. Further takes more.',
  connect: 'Drag it onto something else.', separate: 'Pull two fingers apart on it. With a mouse, hold Shift and drag away from it.', stabilize: 'Draw a circle around it.',
  unmake: 'Scribble over it, then keep your finger down until it commits.', create: 'Press and hold on empty space.', explore: 'Flick into a dashed region, or press and hold on it.',
  signal: 'Triple tap a living thing.', sign: 'Open the study sheet on something and leave three glyphs.',
};
async function study(t) {
  if (!t || t.kind === 'void') t = S.focusId && S.objects.has(S.focusId) ? { kind: 'object', id: S.focusId } : null;
  if (!t) return say('Tap something first. Then you can study it.');
  const sel = t.kind === 'object' ? { kind: 'object', id: t.id } : t.kind === 'frontier' ? { kind: 'cell', gx: t.gx, gy: t.gy } : { kind: 'point', x: t.x, y: t.y };
  const known = new Set(S.me.gestures.map((g) => g.key));
  Object.assign(S, { sel, detail: null, action: null, focus: 1, amount: null, target: null, poss: null, result: null, error: null });
  if (sel.kind === 'object') S.focusId = sel.id;
  $('#sheet').hidden = false; drawMap(); renderSheet();
  try {
    if (sel.kind === 'object') { await refreshDetail(); S.action = known.has('observe') ? 'observe' : null; }
    if (sel.kind === 'cell') S.action = known.has('explore') ? 'explore' : null;
    if (sel.kind === 'point') S.action = known.has('create') ? 'create' : null;
    await loadPoss();
  } catch (err) { S.error = err.message; renderSheet(); }
}
function closeStudy() { if ($('#sheet').hidden) return; S.sel = null; $('#sheet').hidden = true; drawMap(); }
async function refreshDetail() {
  if (S.sel?.kind !== 'object') return;
  const id = S.sel.id, d = await api('/objects/' + id);
  if (S.sel?.kind === 'object' && S.sel.id === id) { S.detail = d; renderSheet(); }
}
async function loadPoss() {
  const sel = S.sel, a = S.laws.actions[S.action]; S.error = null;
  if (!sel || !a) { S.poss = null; return renderSheet(); }
  if (a.amounts && !a.amounts.includes(S.amount)) S.amount = a.amounts[1] ?? a.amounts[0];
  if (a.needs === 'target') { S.poss = null; return renderSheet(); }
  try {
    const key = JSON.stringify([sel, S.action, S.amount]);
    const q = new URLSearchParams({ type: S.action });
    if (a.amounts) q.set('amount', S.amount);
    if (sel.kind === 'cell') { q.set('gx', sel.gx); q.set('gy', sel.gy); }
    if (sel.kind === 'point') { q.set('x', sel.x); q.set('y', sel.y); }
    const p = await api((sel.kind === 'object' ? `/objects/${sel.id}` : '/universe') + '/possibilities?' + q);
    if (key !== JSON.stringify([S.sel, S.action, S.amount])) return;
    S.poss = p.decayed ? null : p;
    if (p.decayed) S.error = 'It has decayed since you last looked.';
  } catch (err) { S.poss = null; S.error = err.message; }
  renderSheet();
}

const pct = (p, exact) => (exact ? (p * 100 >= 10 ? Math.round(p * 100) : (p * 100).toFixed(1)) + '%' : '~' + Math.round(p * 100) + '%');
function spectrumHTML(d) {
  return { bar: `<div class="spectrum">${d.outcomes.map((o, i) => `<div class="segm${o.label ? '' : ' unseen'}" style="flex-grow:${Math.max(0.02, o.p)};flex-basis:0;background-color:${HUES[i % HUES.length]};--c:${HUES[i % HUES.length]}">${o.p >= 0.13 ? `<span>${pct(o.p, d.exact)}</span>` : ''}</div>`).join('')}</div>`,
    legend: `<ul class="legend">${d.outcomes.map((o, i) => `<li><i style="background:${HUES[i % HUES.length]}"></i>${o.label ? `<span>${esc(o.label)}</span>` : '<span class="unseen-t">An outcome you have not witnessed</span>'}<b>${pct(o.p, d.exact)}</b></li>`).join('')}</ul>` };
}

function renderSheet() {
  const el = $('#sheet'), sel = S.sel;
  if (!S.laws || !S.me || !sel) return;
  const known = new Set(S.me.gestures.map((g) => g.key));
  const a = S.laws.actions[S.action], d = S.detail, o = d?.object;
  const r = S.last && !S.last.decayed && sel.kind === 'object' && S.last.objectId === sel.id ? S.last : null;
  let head = '', body = '';
  const close = '<button class="x" data-do="close" aria-label="Close">×</button>';
  if (sel.kind === 'object') {
    if (!o) { el.innerHTML = `<div class="sheet-head"><p class="hint">${esc(S.error || 'Looking…')}</p>${close}</div>`; return; }
    const before = r?.before, delta = (k) => (before?.[k] != null && r.object?.[k] != null && r.object[k] !== before[k] ? `<span class="delta ${r.object[k] > before[k] ? 'up' : 'down'}">${r.object[k] > before[k] ? '+' : ''}${Math.round((r.object[k] - before[k]) * 10) / 10}</span>` : '');
    const stat = (label, k, extra = '') => `<div><dt>${label}</dt><dd class="${o[k] == null ? 'unk' : ''}">${o[k] == null ? '???' : fmt(o[k])}${k === 'stability' && o[k] != null ? '%' : ''}${delta(k)}</dd>${extra}</div>`;
    const facts = [
      o.known ? `${o.state ? esc(o.state[0].toUpperCase() + o.state.slice(1)) + ', in ' : 'In '}Region ${d.regionNum ?? o.regionNum}${o.mine ? '. You made this.' : ''}` : 'You have never observed this. Its nature is unknown to you.',
      o.type === 'core' && o.energy != null ? `It ignites at ${fmt(o.threshold)} energy. ${fmt(Math.max(0, o.threshold - o.energy))} to go.` : '',
      o.was ? `It used to be a ${esc(o.was)}.` : '',
      o.origin ? esc(o.origin) : '',
      d.bonds.length ? `Bonded to ${d.bonds.map((b) => esc(b.label)).join(', ')}.` : '',
      d.otherObservers ? `${d.otherObservers} other observer${d.otherObservers === 1 ? ' has' : 's have'} interacted with this.` : '',
    ].filter(Boolean);
    const chips = d.actions.filter((k) => known.has(k));
    head = `<div class="sheet-head"><div><h2>${esc(o.label)}</h2><p class="sub">${o.known ? esc(o.typeLabel) : 'Unobserved'}${o.complexity != null ? `, complexity ${fmt(o.complexity)}` : ''}</p></div>${close}</div>
      <dl class="stats">${stat('Energy', 'energy', o.type === 'core' && o.energy != null ? `<div class="meter"><i style="width:${Math.min(100, (o.energy / o.threshold) * 100)}%"></i></div>` : '')}${stat('Stability', 'stability')}${stat('Information', 'information')}</dl>
      <div class="facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
      ${chips.length ? `<p class="poss-title" style="margin-top:12px"><span>Odds for the gestures you have found</span></p><div class="chips">${chips.map((k) => `<button class="chip" data-do="action" data-a="${k}" aria-pressed="${k === S.action}">${esc(S.laws.actions[k].label)}</button>`).join('')}</div>` : ''}`;
  } else if (sel.kind === 'cell') {
    head = `<div class="sheet-head"><div><h2>An unexplored region</h2><p class="sub">It has no state you can know until someone arrives.</p></div>${close}</div>`;
  } else {
    head = `<div class="sheet-head"><div><h2>Empty space</h2><p class="sub">Nothing is here. That is not the same as nothing being possible here.</p></div>${close}</div>`;
  }
  if (a) {
    body += `<p class="how">${esc(HOW[S.action] || '')}</p>`;
    if (a.amounts && S.poss) body += `<div class="opts"><span>If the amount were</span>${a.amounts.map((n) => `<button class="opt" data-do="amount" data-n="${n}" aria-pressed="${n === S.amount}">${n}</button>`).join('')}</div>`;
    if (S.poss) {
      const sp = spectrumHTML(S.poss), blur = sel.kind === 'object' ? 'blurred until you observe it more' : 'blurred until you understand probability better';
      body += `<div class="poss"><div class="poss-title"><span>What could happen, costing ${S.poss.cost}</span><span>${S.poss.exact ? 'exact odds' : blur}</span></div>${sp.bar}</div>${sp.legend}${S.poss.modifiers.length ? `<ul class="why">${S.poss.modifiers.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}`;
    }
  } else if (sel.kind !== 'object') body += `<p class="how">You have not found a way to act here yet.</p>`;
  if (r) body += resultHTML(r);
  if (S.error) body += `<p class="error" style="margin-top:10px">${esc(S.error)}</p>`;
  if (sel.kind === 'object' && o) {
    if (o.level >= 1 && o.type !== 'remnant') {
      body += `<div class="sigs"><h3><span>Signals on this</span><button class="pill" data-do="leave">Leave a signal<small style="opacity:.6;margin-left:6px">${d.signalCosts.leave}</small></button></h3>
        ${d.signals.length ? d.signals.map((g) => `<div class="sig"><span class="glyphs">${glyphs(g.pattern)}</span><span class="t">${g.mine ? (g.isEcho ? 'your echo' : g.echoed ? 'yours, echoed by something' : 'yours, no answer yet') : g.isEcho ? 'an echo' : 'left by something'}, tick ${fmt(g.tick)}</span>${g.canEcho ? `<button class="pill go" data-do="echo" data-id="${g.id}">Echo<small style="opacity:.6;margin-left:6px">${d.signalCosts.echo}</small></button>` : '<span></span>'}</div>`).join('') : '<p class="t" style="font-size:13px;color:var(--faint)">Nothing has left a mark here.</p>'}</div>`;
    }
    body += `<div class="links">${o.level >= 2 ? `<button class="quiet" data-do="history">Why does this exist?</button>` : ''}${d.canName ? `<button class="quiet" data-do="name">Name it</button>` : ''}${o.level >= 1 ? `<button class="quiet" data-do="note">Leave a note</button>` : ''}</div>`;
  }
  const top = el.scrollTop;
  el.innerHTML = head + body;
  el.scrollTop = top;
}
function resultHTML(r) {
  const hue = HUES[r.chosen % HUES.length];
  return `<div class="result" style="--c:${hue}"><p class="poss-title"><span>The last thing you did to it</span></p><p class="voice">${esc(r.narrative)}</p>${r.more ? `<p class="more">${esc(r.more)}</p>` : ''}
    <div class="proof"><span>Tick ${fmt(r.universeTick)}</span><span>roll ${r.roll.toFixed(4)}</span><span>seed ${esc(r.seed.slice(0, 10))}…</span><button class="quiet" data-do="verify" data-id="${r.interactionId}">Re-derive it</button><span id="proof"></span></div></div>`;
}

$('#sheet').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-do]'); if (!b) return;
  const what = b.dataset.do;
  if (what === 'close') return closeStudy();
  if (what === 'action') { S.action = b.dataset.a; S.poss = null; renderSheet(); return loadPoss(); }
  if (what === 'amount') { S.amount = Number(b.dataset.n); return loadPoss(); }
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
  const EFFECT = { observe: 'Practice: deeper readings, and exact odds sooner.', touch: 'Practice: it settles more often.', energize: 'Practice: less agitation, and longer holds give larger amounts.',
    draw: 'Practice: fewer leaks and collapses, and you can hold more energy.', connect: 'Practice: longer reach, and bonds form more often.', separate: 'Practice: bonds break more cleanly.',
    stabilize: 'Practice: stronger effect at lower cost.', unmake: 'Practice: it succeeds more often.', create: 'Practice: cheaper, and fades less often.', explore: 'Practice: you find more, and less emptiness.',
    signal: 'Practice: more often answered.', sign: 'Practice: marks you as a Sign-Bearer.' };
  const gs = S.me.gestures, hidden = S.laws.gestureCount - gs.length;
  const codex = `<h2>Gestures</h2><p class="lede">Nothing here was taught to you. You found each of these with your own hands, and each grows only by being used.</p>
    ${gs.length ? gs.map((g) => `<div class="gest"><b>${esc(g.name)}</b><span class="lv">Level ${g.level}</span><span class="howto">${esc(HOW[g.key] || '')}</span>
      <span class="bar"><i style="width:${g.next ? Math.min(100, ((g.uses - g.prev) / (g.next - g.prev)) * 100) : 100}%"></i></span><span class="effect">${fmt(g.uses)} use${g.uses === 1 ? '' : 's'}${g.next ? `, ${fmt(g.next - g.uses)} more to level ${g.level + 1}` : ''}. ${EFFECT[g.key] || ''}</span></div>`).join('') : '<p class="empty">You have not done anything yet. Tap something.</p>'}
    <p class="fine" style="margin-top:12px">${hidden > 0 ? `${hidden} more gesture${hidden === 1 ? ' exists' : 's exist'}. Try things.` : 'You have found every gesture there is.'}</p>`;
  el.innerHTML = codex + `<h2 style="margin-top:34px">What you have learned</h2><p class="lede">Knowledge is not points. It is the set of relationships you have found by experiment. None of it is guaranteed to be true.</p>
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
      if (r.firstGesture) toast(`<b>${esc(r.firstGesture.name)}</b><span class="law">${esc(r.firstGesture.text)}</span><span class="t">Knowledge +1</span>`, 'law');
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
  const p = await api('/users/me'), l = p.life, top = S.me.gestures.slice().sort((a, b) => b.level - a.level || b.uses - a.uses)[0];
  const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  el.innerHTML = `<h2>${esc(p.user.username)}</h2><p class="lede">Your life. There is only this one.</p>
    <p class="voice">${esc(p.user.rank)}</p><p class="fine">${top ? `You are known by what you do most: ${esc(top.name.toLowerCase())}, level ${top.level}.` : 'You will be known by what you do most.'} You can hold up to ${fmt(p.user.capacity)} energy.</p>
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
