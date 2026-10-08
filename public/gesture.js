// GestureRecognizer
// Turns raw pointer input on the map into named gestures. It knows nothing about the
// game: it asks its host what is under a point and reports what the hand did.
// Recognition favours intent over exact shapes; nothing here measures precision.
//
// Gestures reported through host.onGesture({ type, target, ... }):
//   tap, double, triple     on whatever was under the finger
//   hold                    pressed without moving; ms says for how long
//   swipe                   started on an object and left it (len in px, shift for desktop "separate")
//   drag                    started on one object and ended on another (target, onto)
//   circle                  a closed loop drawn around an object
//   scribble                a zigzag over an object, then kept down until it commits
//   flick                   a quick stroke ending in an unexplored region
//   spread                  two fingers pulled apart on an object
//   twoTap                  two fingers tapped together (or right-click)
//   miss                    a stroke that meant nothing
//
// host: { hit(x, y), enclosed(points), near(points), wantsThird(target),
//         onGesture(g), onTrail(points | null, fromObject), onCharge(info | null), onHover(target | null),
//         onPan(dx, dy), onZoom(factor, x, y), busy() }

const HOLD_MS = 450, TAP_GAP = 290, CONFIRM_MS = 750;

export function attachGestures(el, host) {
  const P = new Map();          // active pointers
  let g = null;                 // the one-finger gesture in progress
  let multi = null;             // the two-finger gesture in progress
  let pan = null;               // mouse right/middle drag
  const taps = { n: 0, key: null, at: 0, timer: 0, target: null };
  let raf = 0;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const keyOf = (t) => (t.kind === 'object' ? 'o' + t.id : t.kind === 'frontier' ? `f${t.gx}:${t.gy}` : t.kind);
  const fire = (type, extra) => host.onGesture({ type, ...extra });

  function flushTaps() {
    clearTimeout(taps.timer);
    if (taps.n === 1) fire('tap', { target: taps.target });
    else if (taps.n === 2) fire('double', { target: taps.target });
    taps.n = 0; taps.key = null;
  }
  function tapped(target) {
    const now = performance.now(), key = keyOf(target);
    if (target.kind !== 'object') { flushTaps(); return fire('tap', { target }); }
    if (taps.n && (taps.key !== key || now - taps.at > TAP_GAP + 60)) flushTaps();
    clearTimeout(taps.timer);
    taps.n += 1; taps.key = key; taps.at = now; taps.target = target;
    if (taps.n >= 3) { taps.n = 0; taps.key = null; return fire('triple', { target }); }
    if (taps.n === 2 && !host.wantsThird(target)) { taps.n = 0; taps.key = null; return fire('double', { target }); }
    taps.timer = setTimeout(flushTaps, TAP_GAP);
  }

  function endPrimary() {
    if (!g) return;
    clearTimeout(g.holdTimer); clearTimeout(g.confirmTimer); cancelAnimationFrame(raf);
    host.onCharge(null); host.onTrail(null); host.onHover(null);
    g = null;
  }
  function chargeLoop() {
    if (!g || (g.mode !== 'hold' && !g.confirm)) return;
    const now = performance.now();
    host.onCharge(g.confirm ? { kind: 'confirm', target: g.confirm.target, ms: now - g.confirm.t0, total: CONFIRM_MS } : { kind: 'hold', target: g.target, ms: now - g.t0 });
    raf = requestAnimationFrame(chargeLoop);
  }

  // sharp direction reversals along a stroke
  function reversals(pts) {
    let n = 0, last = null, anchor = pts[0];
    for (const p of pts) {
      if (dist(p, anchor) < 13) continue;
      const v = { x: p.x - anchor.x, y: p.y - anchor.y };
      if (last && (v.x * last.x + v.y * last.y) / (Math.hypot(v.x, v.y) * Math.hypot(last.x, last.y)) < -0.25) n++;
      last = v; anchor = p;
    }
    return n;
  }
  function isLoop(pts) {
    if (pts.length < 10) return false;
    let len = 0, minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; if (i) len += dist(p, pts[i - 1]);
      minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); maxx = Math.max(maxx, p.x); maxy = Math.max(maxy, p.y); cx += p.x; cy += p.y;
    }
    cx /= pts.length; cy /= pts.length;
    const diag = Math.hypot(maxx - minx, maxy - miny);
    if (len < 110 || diag < 36) return false;
    // how far around its own centre the stroke travelled; a generous three quarters of a turn is enough
    let turn = 0, prev = Math.atan2(pts[0].y - cy, pts[0].x - cx);
    for (const p of pts) { const a = Math.atan2(p.y - cy, p.x - cx); let d = a - prev; if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI; turn += d; prev = a; }
    return Math.abs(turn) > Math.PI * 1.5 && dist(pts[0], pts[pts.length - 1]) < Math.max(46, diag * 0.55);
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) { pan = { x: e.clientX, y: e.clientY, moved: 0, button: e.button }; el.setPointerCapture(e.pointerId); return; }
    if (e.isPrimary) { P.clear(); multi = null; }
    P.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { el.setPointerCapture(e.pointerId); } catch {}
    if (P.size === 2) {
      endPrimary();
      const [a, b] = [...P.values()], c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      multi = { t0: performance.now(), d0: dist(a, b), d: dist(a, b), c, c0: c, moved: 0, target: host.hit(c.x, c.y), mode: null };
      return;
    }
    if (P.size !== 1) return;
    const p = { x: e.clientX, y: e.clientY };
    g = { id: e.pointerId, t0: performance.now(), p0: p, pts: [p], target: host.hit(p.x, p.y), mode: 'press', shift: e.shiftKey, slop: e.pointerType === 'mouse' ? 5 : 11 };
    if (g.target.kind !== 'void') g.holdTimer = setTimeout(() => { if (g && g.mode === 'press') { g.mode = 'hold'; chargeLoop(); } }, HOLD_MS);
  });

  el.addEventListener('pointermove', (e) => {
    if (pan) { const dx = e.clientX - pan.x, dy = e.clientY - pan.y; pan.moved += Math.abs(dx) + Math.abs(dy); pan.x = e.clientX; pan.y = e.clientY; if (pan.moved > 4) host.onPan(dx, dy); return; }
    const cur = P.get(e.pointerId); if (!cur) return;
    cur.x = e.clientX; cur.y = e.clientY;
    if (multi && P.size >= 2) {
      const [a, b] = [...P.values()], d = dist(a, b), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      multi.moved += dist(c, multi.c) + Math.abs(d - multi.d);
      if (!multi.mode && multi.moved > 9) {
        // on an object, wait to see whether the fingers part (a pull apart) or travel together (moving the map)
        if (multi.target.kind !== 'object' || dist(c, multi.c0) > 24 || d - multi.d0 < -18) multi.mode = 'nav';
        else if (d - multi.d0 > 26) multi.mode = 'spread';
      }
      if (multi.mode === 'nav') { host.onPan(c.x - multi.c.x, c.y - multi.c.y); if (multi.d > 0) host.onZoom(d / multi.d, c.x, c.y); }
      if (multi.mode === 'spread') host.onCharge({ kind: 'spread', target: multi.target, ms: Math.min(1, (d - multi.d0) / 90) });
      multi.c = c; multi.d = d;
      return;
    }
    if (!g || g.id !== e.pointerId || g.done) return;
    const p = { x: e.clientX, y: e.clientY };
    g.pts.push(p);
    const far = dist(p, g.p0);
    if (g.mode === 'press' && far > g.slop) { g.mode = 'trace'; clearTimeout(g.holdTimer); }
    if (g.mode === 'hold' && far > 24) {             // the finger wandered: a hold on a thing becomes a stroke; a hold on nothing is abandoned
      cancelAnimationFrame(raf); host.onCharge(null);
      if (g.target.kind === 'object') g.mode = 'trace'; else { g.done = true; return; }
    }
    if (g.mode !== 'trace') return;
    host.onTrail(g.pts, g.target.kind === 'object' ? g.target : null);
    if (g.target.kind === 'object') { const over = host.hit(p.x, p.y); host.onHover(over.kind === 'object' && over.id !== g.target.id ? over : null); }
    // a zigzag over something arms an unmaking; it only commits if the finger stays down
    if (!g.confirm && g.pts.length > 8 && reversals(g.pts) >= 4) {
      const target = g.target.kind === 'object' ? g.target : host.near(g.pts);
      if (target) {
        g.confirm = { target, t0: performance.now() };
        chargeLoop();
        g.confirmTimer = setTimeout(() => { if (!g || !g.confirm) return; const t = g.confirm.target; g.done = true; host.onCharge(null); host.onTrail(null); fire('scribble', { target: t }); }, CONFIRM_MS);
      }
    }
  });

  function up(e) {
    if (pan) {
      const wasClick = pan.moved <= 4 && pan.button === 2 && e.type === 'pointerup';
      pan = null;
      if (wasClick) fire('twoTap', { target: host.hit(e.clientX, e.clientY) });
      return;
    }
    const had = P.delete(e.pointerId);
    if (multi) {
      if (P.size < 2) {
        const m = multi; multi = null; host.onCharge(null);
        if (e.type === 'pointerup') {
          if (m.mode === 'spread') fire('spread', { target: m.target });
          else if (!m.mode && performance.now() - m.t0 < 380) fire('twoTap', { target: m.target });
        }
        P.clear();
      }
      return;
    }
    if (!had || !g || g.id !== e.pointerId) return;
    const cur = g, ms = performance.now() - g.t0, end = { x: e.clientX, y: e.clientY };
    endPrimary();
    if (e.type !== 'pointerup' || cur.done) return;
    if (cur.mode === 'press') return tapped(cur.target);
    if (cur.mode === 'hold') return fire('hold', { target: cur.target, ms });
    // a stroke
    let len = 0; for (let i = 1; i < cur.pts.length; i++) len += dist(cur.pts[i], cur.pts[i - 1]);
    const endHit = host.hit(end.x, end.y);
    if (cur.target.kind === 'object') {
      if (endHit.kind === 'object' && endHit.id !== cur.target.id) return fire('drag', { target: cur.target, onto: endHit });
      if (dist(end, cur.p0) > 40) return fire('swipe', { target: cur.target, len: dist(end, cur.p0), shift: cur.shift });
      return;
    }
    if (!cur.confirm && reversals(cur.pts) < 2 && isLoop(cur.pts)) { const target = host.enclosed(cur.pts); if (target) return fire('circle', { target }); }
    const sameCell = cur.target.kind === 'frontier' && cur.target.gx === endHit.gx && cur.target.gy === endHit.gy;
    if (endHit.kind === 'frontier' && !sameCell && ms < 800 && len > 40) return fire('flick', { target: endHit });
    fire('miss', { len, armed: !!cur.confirm });
  }
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('wheel', (e) => { e.preventDefault(); host.onZoom(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY); }, { passive: false });
}
