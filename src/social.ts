// SIGNALS, CONTACT AND SPEECH
// Observers cannot see each other. They can leave a three-glyph signal on an object
// and anyone, or anything, may echo it. The universe leaves signals and echoes too.
// Contact happens only when an observer answers an echo that came from another observer.
import type { Router, Request, Response } from 'express';
import type { DB, Q } from './db.js';
import { evaluateDiscoveries } from './engine/discoveries.js';
import { GESTURES, TYPES } from './engine/laws.js';
import { roll, sha } from './engine/rng.js';
import { GameError, regenDue } from './engine/world.js';

export const SIGNAL = { leaveCost: 5, echoCost: 3, glyphs: 6, visibleTicks: 40000, perObject: 6,
  universeEchoChance: 0.3, universeEchoDelay: [40, 1200], noiseChance: 0.08 };

export async function contactsOf(q: Q, userId: number) {
  const rows = await q(
    `SELECT c.id, c.created_tick, u.id AS other_id, u.username FROM contacts c JOIN users u ON u.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
      WHERE c.user_a = $1 OR c.user_b = $1 ORDER BY c.id`, [userId]);
  return new Map<number, { id: number; username: string; tick: number }>(rows.map((r) => [Number(r.other_id), { id: Number(r.id), username: r.username, tick: Number(r.created_tick) }]));
}
// How another observer appears to this one: by name only after contact.
export const whoIs = (id: number | null, name: string | null, me: number, known: Map<number, any>, cap = true) =>
  id == null ? null : Number(id) === me ? (cap ? 'You' : 'you') : known.has(Number(id)) ? name : cap ? 'An observer' : 'an observer';

// Spend energy into the vacuum (LAW_ENERGY_CONSERVATION), inside the caller's transaction.
async function spend(q: Q, userId: number, cost: number) {
  const [u] = await q('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!u) throw new GameError(401, 'Unknown observer.');
  if (u.life_state !== 'alive') throw new GameError(403, 'An echo can watch, but it can no longer act.');
  if (Number(u.energy) + regenDue(u) < cost) throw new GameError(400, `Not enough energy. This needs ${cost}, you hold ${u.energy}.`);
  await q('SELECT 1 FROM universe WHERE id = 1 FOR UPDATE');
  const due = regenDue(u);   // settle the slow recharge first, so it cannot be banked
  u.energy = Number(u.energy) + due;
  await q('UPDATE users SET energy = $2, energy_updated_at = now(), last_seen = now() WHERE id = $1', [userId, u.energy - cost]);
  await q('UPDATE universe SET free_energy = free_energy + $1 WHERE id = 1', [cost - due]);
  const [uni] = await q('SELECT current_tick FROM universe WHERE id = 1');
  return { user: u, tick: Number(uni.current_tick) };
}
async function learn(q: Q, user: any, tick: number, key: string, objectId: number) {
  user.stats = { ...user.stats, [key]: (user.stats?.[key] || 0) + 1 };
  const found = await evaluateDiscoveries(q, user, tick, objectId);
  await q('UPDATE users SET stats = $2::jsonb, domains = $3::jsonb, knowledge = $4 WHERE id = $1', [user.id, JSON.stringify(user.stats), JSON.stringify(user.domains || {}), user.knowledge]);
  return found;
}

// The signals an observer can see on one object. Nothing here says who left them.
export async function signalsOn(q: Q, objectId: number, me: number, tick: number) {
  const rows = await q(
    `SELECT s.id, s.pattern, s.universe_tick AS tick, s.user_id, s.reply_to,
            EXISTS (SELECT 1 FROM signals e WHERE e.reply_to = s.id) AS echoed,
            EXISTS (SELECT 1 FROM signals e WHERE e.reply_to = s.id AND e.user_id = $2) AS echoed_by_me
       FROM signals s WHERE s.object_id = $1 AND s.universe_tick > $3 ORDER BY s.id DESC LIMIT $4`, [objectId, me, tick - SIGNAL.visibleTicks, SIGNAL.perObject]);
  return rows.map((s) => ({ id: Number(s.id), pattern: s.pattern, tick: Number(s.tick), mine: Number(s.user_id) === me, isEcho: s.reply_to != null, echoed: s.echoed, canEcho: Number(s.user_id) !== me && !s.echoed_by_me }));
}

export function social(r: Router, db: DB, h: { wrap: (fn: (req: Request, res: Response) => Promise<any>) => any; uid: (req: Request) => number; limit: any }) {
  const { wrap, uid, limit } = h;
  const int = (v: any) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : 0);

  // Leave a signal on an object you have observed.
  r.post('/objects/:id/signal', limit, wrap(async (req) => {
    const pattern = String(req.body?.pattern || '');
    if (!/^[0-5]{3}$/.test(pattern)) throw new GameError(400, 'A signal is three glyphs.');
    return db.tx(async (q) => {
      const me = uid(req);
      const [o] = await q(
        `SELECT o.id, o.state, COALESCE(ob.level, 0) AS lvl, EXISTS (SELECT 1 FROM user_regions ur WHERE ur.user_id = $1 AND ur.region_id = o.region_id) AS reachable
           FROM objects o LEFT JOIN observations ob ON ob.object_id = o.id AND ob.user_id = $1 WHERE o.id = $2`, [me, int(req.params.id)]);
      if (!o || !o.reachable || o.state === 'merged') throw new GameError(404, 'There is nothing there.');
      if (Number(o.lvl) < 1) throw new GameError(403, 'Observe it before you leave a signal on it.');
      const { user, tick } = await spend(q, me, SIGNAL.leaveCost);
      const [open] = await q('SELECT 1 AS x FROM signals WHERE object_id = $1 AND user_id = $2 AND reply_to IS NULL AND universe_tick > $3 LIMIT 1', [o.id, me, tick - 500]);
      if (open) throw new GameError(400, 'Your last signal here is still fresh. Give it time.');
      const [s] = await q('INSERT INTO signals (object_id, user_id, pattern, universe_tick) VALUES ($1, $2, $3, $4) RETURNING id', [o.id, me, pattern, tick]);
      const newDiscoveries = await learn(q, user, tick, 'signals', Number(o.id));
      return { ok: true, id: Number(s.id), energy: Number(user.energy) - SIGNAL.leaveCost, newDiscoveries,
        firstGesture: user.stats.signals === 1 ? { key: 'sign', name: GESTURES.sign.name, text: GESTURES.sign.first } : null,
        narrative: 'Your signal is on it now. Anything that looks closely will see it.' };
    });
  }));

  // Echo a signal: repeat it back. If the signal you echo was itself an echo of yours,
  // and it came from an observer, the two of you have found each other.
  r.post('/signals/:id/echo', limit, wrap(async (req) => db.tx(async (q) => {
    const me = uid(req);
    const [s] = await q(
      `SELECT s.*, root.user_id AS root_user, EXISTS (SELECT 1 FROM user_regions ur WHERE ur.user_id = $1 AND ur.region_id = o.region_id) AS reachable,
              COALESCE(ob.level, 0) AS lvl
         FROM signals s JOIN objects o ON o.id = s.object_id LEFT JOIN signals root ON root.id = s.reply_to
         LEFT JOIN observations ob ON ob.object_id = o.id AND ob.user_id = $1 WHERE s.id = $2`, [me, int(req.params.id)]);
    if (!s || !s.reachable) throw new GameError(404, 'That signal is not there.');
    if (Number(s.lvl) < 1) throw new GameError(403, 'Observe the object before you answer what is on it.');
    if (Number(s.user_id) === me) throw new GameError(400, 'That signal is your own.');
    if ((await q('SELECT 1 AS x FROM signals WHERE reply_to = $1 AND user_id = $2', [s.id, me])).length) throw new GameError(400, 'You have already echoed that.');
    const { user, tick } = await spend(q, me, SIGNAL.echoCost);
    const [e] = await q('INSERT INTO signals (object_id, user_id, pattern, reply_to, universe_tick) VALUES ($1, $2, $3, $4, $5) RETURNING id', [s.object_id, me, s.pattern, s.id, tick]);
    let contact: { id: number; username: string } | null = null;
    const other = s.user_id == null ? null : Number(s.user_id);
    if (other && s.reply_to != null && Number(s.root_user) === me) {   // I answered an echo of my own signal, and the echo was an observer's
      const [a, b] = me < other ? [me, other] : [other, me];
      const [c] = await q('INSERT INTO contacts (user_a, user_b, signal_id, created_tick) VALUES ($1, $2, $3, $4) ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id', [a, b, e.id, tick]);
      if (c) {
        const [o] = await q('SELECT username, stats, domains, knowledge, id FROM users WHERE id = $1 FOR UPDATE', [other]);
        contact = { id: Number(c.id), username: o.username };
        await learn(q, o, tick, 'contacts', Number(s.object_id));
        user.stats = { ...user.stats, contacts: (user.stats?.contacts || 0) + 1 };
        await q(`INSERT INTO events (universe_tick, event_type, description, affected_object_id, impact) VALUES ($1, 'CONTACT', 'Two observers found each other.', $2, 'major')`, [tick, s.object_id]);
      }
    }
    const newDiscoveries = await learn(q, user, tick, 'echoes', Number(s.object_id));
    return { ok: true, id: Number(e.id), contact, energy: Number(user.energy) - SIGNAL.echoCost, newDiscoveries,
      narrative: contact ? `It was not the universe. It was ${contact.username}. You can speak to each other now.` : 'You echoed it. If something is there, it knows now.' };
  })));

  // Your own signals and what has come back, and the observers you have found.
  r.get('/signals', wrap(async (req) => {
    const me = uid(req);
    const mine = await db.q(
      `SELECT s.id, s.pattern, s.universe_tick AS tick, s.object_id, o.name, o.type, o.state,
              (SELECT e.id FROM signals e WHERE e.reply_to = s.id AND (e.user_id IS NULL OR e.user_id <> $1)
                  AND NOT EXISTS (SELECT 1 FROM signals a WHERE a.reply_to = e.id AND a.user_id = $1) ORDER BY e.id LIMIT 1) AS open_echo,
              (SELECT COUNT(*) FROM signals e WHERE e.reply_to = s.id) AS echoes
         FROM signals s JOIN objects o ON o.id = s.object_id WHERE s.user_id = $1 AND s.reply_to IS NULL ORDER BY s.id DESC LIMIT 30`, [me]);
    const known = await contactsOf(db.q, me);
    const contacts: any[] = [];
    for (const [otherId, c] of known) {
      const [last] = await db.q('SELECT id, body, user_id, universe_tick AS tick FROM messages WHERE contact_id = $1 ORDER BY id DESC LIMIT 1', [c.id]);
      contacts.push({ id: c.id, username: c.username, sinceTick: c.tick, otherId, last: last ? { id: Number(last.id), body: last.body, mine: Number(last.user_id) === me, tick: Number(last.tick) } : null });
    }
    return {
      costs: { leave: SIGNAL.leaveCost, echo: SIGNAL.echoCost },
      signals: mine.map((s) => ({ id: Number(s.id), pattern: s.pattern, tick: Number(s.tick), objectId: Number(s.object_id), object: s.name || `${TYPES[s.type]?.label ?? 'Object'} #${s.object_id}`,
        echoes: Number(s.echoes), openEcho: s.open_echo ? Number(s.open_echo) : null })),
      contacts,
    };
  }));

  const myContact = async (q: Q, me: number, id: number) => {
    const [c] = await q('SELECT * FROM contacts WHERE id = $1 AND (user_a = $2 OR user_b = $2)', [id, me]);
    if (!c) throw new GameError(404, 'You have not made contact with that observer.');
    return c;
  };
  r.get('/contacts/:id/messages', wrap(async (req) => {
    const me = uid(req), c = await myContact(db.q, me, int(req.params.id));
    const rows = await db.q('SELECT * FROM (SELECT id, user_id, body, universe_tick AS tick, created_at FROM messages WHERE contact_id = $1 AND id > $2 ORDER BY id DESC LIMIT 100) m ORDER BY id', [c.id, int(req.query.after)]);
    return { messages: rows.map((m) => ({ id: Number(m.id), mine: Number(m.user_id) === me, body: m.body, tick: Number(m.tick), at: m.created_at })) };
  }));
  r.post('/contacts/:id/messages', limit, wrap(async (req) => {
    const body = String(req.body?.body || '').trim();
    if (!body || body.length > 500) throw new GameError(400, 'A message is 1 to 500 characters.');
    const me = uid(req), c = await myContact(db.q, me, int(req.params.id));
    const [m] = await db.q('INSERT INTO messages (contact_id, user_id, body, universe_tick) VALUES ($1, $2, $3, (SELECT current_tick FROM universe WHERE id = 1)) RETURNING id, universe_tick AS tick', [c.id, me, body]);
    return { ok: true, id: Number(m.id), tick: Number(m.tick) };
  }));
}

// What the pulse needs: has anything come back to me?
export async function socialPulse(q: Q, me: number) {
  const [r] = await q(
    `SELECT (SELECT COALESCE(MAX(e.id), 0) FROM signals e JOIN signals s ON s.id = e.reply_to WHERE s.user_id = $1 AND (e.user_id IS NULL OR e.user_id <> $1)) AS echo,
            (SELECT COALESCE(MAX(c.id), 0) FROM contacts c WHERE c.user_a = $1 OR c.user_b = $1) AS contact,
            (SELECT COALESCE(MAX(m.id), 0) FROM messages m JOIN contacts c ON c.id = m.contact_id WHERE (c.user_a = $1 OR c.user_b = $1) AND m.user_id <> $1) AS message`, [me]);
  return { echo: Number(r.echo), contact: Number(r.contact), message: Number(r.message) };
}

// The universe's own voice: it leaves signals on things, and it echoes some of the
// signals observers leave. It never answers a second time.
export async function universeSignals(q: Q, tick: number, epoch: number, regionIds: string[]) {
  for (const id of regionIds) {
    const s = sha(`noise:${epoch}:${id}`);
    if (roll(s) >= SIGNAL.noiseChance) continue;
    const objs = await q(`SELECT id FROM objects WHERE region_id = $1 AND state <> 'merged' AND type <> 'remnant' ORDER BY id LIMIT 60`, [id]);
    if (!objs.length) continue;
    const o = objs[Math.floor(roll(s, 'obj') * objs.length)];
    const pattern = [0, 1, 2].map((i) => Math.floor(roll(s, 'g' + i) * SIGNAL.glyphs)).join('');
    await q('INSERT INTO signals (object_id, user_id, pattern, universe_tick) VALUES ($1, NULL, $2, $3)', [o.id, pattern, tick]);
  }
  const open = await q(
    `SELECT s.id, s.object_id, s.pattern, s.universe_tick AS tick FROM signals s
      WHERE s.user_id IS NOT NULL AND s.reply_to IS NULL AND s.universe_tick > $1
        AND NOT EXISTS (SELECT 1 FROM signals e WHERE e.reply_to = s.id AND e.user_id IS NULL) ORDER BY s.id DESC LIMIT 60`, [tick - 5000]);
  for (const s of open) {
    const k = sha(`universe-echo:${s.id}`);
    if (roll(k) >= SIGNAL.universeEchoChance) continue;   // decided once per signal: most are never answered by the universe
    const delay = SIGNAL.universeEchoDelay[0] + roll(k, 'delay') * (SIGNAL.universeEchoDelay[1] - SIGNAL.universeEchoDelay[0]);
    if (tick - Number(s.tick) < delay) continue;
    await q('INSERT INTO signals (object_id, user_id, pattern, reply_to, universe_tick) VALUES ($1, NULL, $2, $3, $4)', [s.object_id, s.pattern, s.id, tick]);
  }
}
