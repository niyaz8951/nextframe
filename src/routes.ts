import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import type { DB } from './db.js';
import { login, register, requireAuth } from './auth.js';
import { ACTIONS, KNOWLEDGE_DOMAINS, LAW_ENERGY_CONSERVATION as EC, REGION_SIZE, TYPES, level, rankOf } from './engine/laws.js';
import { DISCOVERIES } from './engine/discoveries.js';
import { interact, possibilities, publicUser, verify, viewObject } from './engine/interact.js';
import { GameError, labelOf } from './engine/world.js';

const wrap = (fn: (req: Request, res: Response) => Promise<any>) => (req: Request, res: Response) =>
  fn(req, res).then((out) => { if (out !== undefined) res.json(out); }).catch((e) => {
    if (e instanceof GameError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'The universe hesitated. Try again.' });
  });
const uid = (req: Request) => (req as any).userId as number;
const int = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Math.floor(Number(v)) : d);
const publicObjectName = (o: any) => o.name || `Object #${o.id}`;

export function api(db: DB) {
  const r = Router();
  const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: config.authRateMax, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Wait a few minutes.' } });
  const actLimit = rateLimit({ windowMs: 60_000, limit: config.actRateMax, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => 'u' + uid(req), message: { error: 'Slow down. The universe needs a moment between frames.' } });

  r.post('/auth/register', authLimit, wrap(async (req) => register(db, req.body)));
  r.post('/auth/login', authLimit, wrap(async (req) => login(db, req.body)));
  r.get('/laws', wrap(async () => ({
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, { label: a.label, cost: a.cost, needs: a.needs, amounts: a.amounts, focusable: !!a.focusable, domain: a.domain }])),
    regionSize: REGION_SIZE, domains: KNOWLEDGE_DOMAINS, observerCap: EC.observerCap, regenCap: EC.regenCap, regenSeconds: EC.regenSeconds,
  })));

  r.use(requireAuth);
  const me = async (id: number) => {
    const [u] = await db.q('SELECT * FROM users WHERE id = $1', [id]);
    if (!u) throw new GameError(401, 'Unknown observer.');
    return u;
  };

  // ---- the observer -------------------------------------------------------------
  r.get('/me', wrap(async (req) => {
    const u = await me(uid(req));
    const [uni] = await db.q('SELECT current_tick FROM universe WHERE id = 1');
    const since = Number(u.last_seen_tick);
    const events = await db.q(`SELECT e.universe_tick AS tick, e.event_type AS type, e.description, e.impact FROM events e WHERE e.universe_tick > $1 AND e.impact <> 'minor' AND (e.created_by_user_id IS NULL OR e.created_by_user_id <> $2) ORDER BY e.id DESC LIMIT 6`, [since, u.id]);
    const [count] = await db.q(`SELECT COUNT(*) AS n FROM events WHERE universe_tick > $1 AND impact <> 'minor'`, [since]);
    const touched = await db.q(
      `SELECT us.username, i.interaction_type AS type, i.outcome, i.universe_tick AS tick, o.id AS object_id, o.name, o.type AS object_type
         FROM interactions i JOIN objects o ON o.id = i.object_id JOIN users us ON us.id = i.user_id
        WHERE o.owner_user_id = $1 AND i.user_id <> $1 AND i.universe_tick > $2 ORDER BY i.id DESC LIMIT 5`, [u.id, since]);
    const changed = await db.q(
      `SELECT e.description, e.universe_tick AS tick FROM events e JOIN observations ob ON ob.object_id = e.affected_object_id AND ob.user_id = $1
        WHERE e.universe_tick > $2 AND (e.created_by_user_id IS NULL OR e.created_by_user_id <> $1) AND e.event_type IN ('COLLAPSE','TRANSFORMATION','STAR_IGNITION','MERGE','LIFE') ORDER BY e.id DESC LIMIT 5`, [u.id, since]);
    return {
      user: publicUser(u), tick: uni.current_tick,
      away: { ticks: Number(uni.current_tick) - since, majorEvents: Number(count.n), events, changed,
        touched: touched.map((t) => ({ username: t.username, verb: ACTIONS[t.type]?.verb || t.type, object: t.name || `${TYPES[t.object_type]?.label} #${t.object_id}`, tick: t.tick })) },
    };
  }));
  r.post('/me/seen', wrap(async (req) => {
    await db.q('UPDATE users SET last_seen = now(), last_seen_tick = (SELECT current_tick FROM universe WHERE id = 1) WHERE id = $1', [uid(req)]);
    return { ok: true };
  }));

  // ---- the universe -------------------------------------------------------------
  r.get('/universe', wrap(async (req) => {
    const u = await me(uid(req));
    const [uni] = await db.q('SELECT * FROM universe WHERE id = 1');
    const [pop] = await db.q('SELECT COUNT(*) AS n FROM users');
    const regions = await db.q(
      `SELECT r.id, r.num, r.gx, r.gy, r.entropy, r.state, r.converged, r.interaction_count, ur.discovered_tick,
              (SELECT COUNT(*) FROM user_regions x WHERE x.region_id = r.id) AS observers
         FROM user_regions ur JOIN regions r ON r.id = ur.region_id WHERE ur.user_id = $1`, [u.id]);
    const known = new Set(regions.map((x) => x.id));
    const frontier = new Map<string, { gx: number; gy: number }>();
    for (const g of regions) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const id = `${g.gx + dx}:${g.gy + dy}`;
      if (!known.has(id)) frontier.set(id, { gx: g.gx + dx, gy: g.gy + dy });
    }
    const rows = await db.q(
      `SELECT o.*, COALESCE(ob.level, 0) AS obs_level, r.entropy AS region_entropy
         FROM objects o JOIN user_regions ur ON ur.region_id = o.region_id AND ur.user_id = $1
         JOIN regions r ON r.id = o.region_id
         LEFT JOIN observations ob ON ob.object_id = o.id AND ob.user_id = $1
        WHERE o.state <> 'merged' ORDER BY o.id LIMIT 1500`, [u.id]);
    const ids = new Set(rows.map((o) => Number(o.id)));
    const rel = await db.q(
      `SELECT rl.id, rl.object_a AS a, rl.object_b AS b, rl.strength FROM relationships rl
         JOIN objects o ON o.id = rl.object_a JOIN user_regions ur ON ur.region_id = o.region_id AND ur.user_id = $1
        WHERE rl.ended_tick IS NULL LIMIT 2000`, [u.id]);
    const others = await db.q(
      `SELECT username, current_location AS region FROM users WHERE id <> $1 AND last_seen > now() - interval '5 minutes'
          AND current_location IN (SELECT region_id FROM user_regions WHERE user_id = $1) LIMIT 30`, [u.id]);
    return {
      universe: { tick: uni.current_tick, entropy: uni.entropy, totalEnergy: uni.total_energy, freeEnergy: uni.free_energy, totalInformation: uni.total_information, observers: Number(pop.n) },
      user: publicUser(u), firstObject: u.stats?.first_object ?? null,
      regions: regions.map((g) => ({ id: g.id, num: g.num, gx: g.gx, gy: g.gy, entropy: Math.round(g.entropy), state: g.state, converged: g.converged, observers: Number(g.observers), interactions: Number(g.interaction_count) })),
      frontier: [...frontier.values()],
      objects: rows.map((o) => viewObject(o, Number(o.obs_level), Number(uni.current_tick), o.region_entropy, u.id)),
      relationships: rel.filter((x) => ids.has(Number(x.a)) && ids.has(Number(x.b))),
      others,
    };
  }));

  // Cheap heartbeat for the client: has anything happened? Also returns what others just did nearby.
  r.get('/universe/pulse', wrap(async (req) => {
    const after = int(req.query.after, 0);
    const [uni] = await db.q('SELECT current_tick, entropy FROM universe WHERE id = 1');
    const [last] = await db.q('SELECT COALESCE(MAX(id), 0) AS id FROM interactions');
    const [u] = await db.q('UPDATE users SET last_seen = now(), last_seen_tick = $2 WHERE id = $1 RETURNING *', [uid(req), uni.current_tick]);
    const ripples = after > 0 ? await db.q(
      `SELECT i.id, i.object_id, i.interaction_type AS type, us.username, o.x, o.y
         FROM interactions i JOIN users us ON us.id = i.user_id JOIN objects o ON o.id = i.object_id
         JOIN user_regions ur ON ur.region_id = o.region_id AND ur.user_id = $1
        WHERE i.id > $2 AND i.user_id <> $1 ORDER BY i.id DESC LIMIT 12`, [uid(req), after]) : [];
    const [ev] = await db.q(`SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE impact <> 'minor'`);
    return { tick: uni.current_tick, entropy: uni.entropy, lastInteraction: Number(last.id), lastMajorEvent: Number(ev.id), energy: publicUser(u).energy, ripples };
  }));

  const eventRows = (where: string, params: any[], limit: number) => db.q(
    `SELECT e.id, e.universe_tick AS tick, e.event_type AS type, e.description, e.impact, e.affected_object_id AS "objectId", r.num AS region, e.created_at AS at
       FROM events e LEFT JOIN regions r ON r.id = e.region_id ${where} ORDER BY e.id DESC LIMIT ${limit}`, params);
  r.get('/universe/feed', wrap(async (req) => ({ events: await eventRows(`WHERE e.impact <> 'minor' AND ($1 = 0 OR e.id < $1)`, [int(req.query.before, 0)], 40) })));
  r.get('/events', wrap(async (req) => ({ events: await eventRows('WHERE ($1 = 0 OR e.id < $1)', [int(req.query.before, 0)], 50) })));
  r.get('/timeline', wrap(async (req) => {
    const mine = req.query.mine === '1';
    const rows = await db.q(
      `SELECT i.id, i.universe_tick AS tick, i.interaction_type AS type, i.outcome, i.energy_spent AS spent, i.user_id, us.username, i.object_id, o.name, o.id AS oid
         FROM interactions i JOIN users us ON us.id = i.user_id LEFT JOIN objects o ON o.id = i.object_id
        WHERE ($1 = 0 OR i.id < $1) AND ($2 = 0 OR i.user_id = $2) ORDER BY i.id DESC LIMIT 50`, [int(req.query.before, 0), mine ? uid(req) : 0]);
    return { interactions: rows.map((i) => ({ id: Number(i.id), tick: i.tick, observer: i.username, mine: Number(i.user_id) === uid(req), type: i.type, verb: ACTIONS[i.type]?.verb || i.type,
      object: i.oid ? publicObjectName(i) : i.type === 'explore' ? 'an unknown region' : 'empty space', objectId: i.object_id, outcome: ACTIONS[i.type]?.outcomes[i.outcome] || i.outcome, spent: Number(i.spent) })) };
  }));

  r.get('/universe/possibilities', wrap(async (req) => possibilities(db, { userId: uid(req), type: String(req.query.type), gx: Number(req.query.gx), gy: Number(req.query.gy), x: Number(req.query.x), y: Number(req.query.y) })));
  r.post('/universe/explore', actLimit, wrap(async (req) => interact(db, { userId: uid(req), type: 'explore', gx: req.body?.gx, gy: req.body?.gy })));
  r.post('/universe/create', actLimit, wrap(async (req) => interact(db, { userId: uid(req), type: 'create', x: req.body?.x, y: req.body?.y })));

  // ---- objects ------------------------------------------------------------------
  const seen = async (userId: number, id: number) => {
    const [o] = await db.q(
      `SELECT o.*, COALESCE(ob.level, 0) AS obs_level, r.entropy AS region_entropy, r.num AS region_num,
              EXISTS (SELECT 1 FROM user_regions ur WHERE ur.user_id = $1 AND ur.region_id = o.region_id) AS reachable
         FROM objects o JOIN regions r ON r.id = o.region_id LEFT JOIN observations ob ON ob.object_id = o.id AND ob.user_id = $1 WHERE o.id = $2`, [userId, id]);
    if (!o) throw new GameError(404, 'There is nothing there.');
    if (!o.reachable) throw new GameError(403, 'You have not explored that region.');
    return o;
  };
  r.get('/objects/:id', wrap(async (req) => {
    const o = await seen(uid(req), int(req.params.id));
    const [uni] = await db.q('SELECT current_tick FROM universe WHERE id = 1');
    const lvl = Number(o.obs_level);
    const bonds = await db.q(
      `SELECT p.id, p.type, p.name, rl.strength, COALESCE(ob.level, 0) AS lvl FROM relationships rl JOIN objects p ON p.id IN (rl.object_a, rl.object_b) AND p.id <> $1
         LEFT JOIN observations ob ON ob.object_id = p.id AND ob.user_id = $2
        WHERE (rl.object_a = $1 OR rl.object_b = $1) AND rl.ended_tick IS NULL`, [o.id, uid(req)]);
    const [watch] = await db.q('SELECT COUNT(DISTINCT user_id) AS n FROM interactions WHERE object_id = $1 AND user_id <> $2', [o.id, uid(req)]);
    const basic = ['observe', 'touch', 'energize', 'draw', 'connect'];
    const actions = Object.entries(ACTIONS).filter(([k, a]) => (a.needs === 'object' || a.needs === 'target') && (lvl >= 1 ? !a.only || a.only(o.type) : basic.includes(k))).map(([k]) => k);
    return {
      object: { ...viewObject(o, lvl, Number(uni.current_tick), o.region_entropy, uid(req)), regionNum: o.region_num },
      bonds: bonds.map((b) => ({ id: Number(b.id), strength: b.strength, label: Number(b.lvl) >= 1 ? b.name || `${TYPES[b.type]?.label} #${b.id}` : `Unknown Object #${b.id}` })),
      otherObservers: Number(watch.n), actions, canName: lvl >= 3 && !o.name && o.type !== 'remnant',
      merged: o.state === 'merged' ? o.props?.merged_into : null,
    };
  }));
  r.get('/objects/:id/possibilities', wrap(async (req) => possibilities(db, {
    userId: uid(req), type: String(req.query.type), objectId: int(req.params.id), targetId: req.query.target ? int(req.query.target) : undefined,
    focus: int(req.query.focus, 1), amount: req.query.amount ? int(req.query.amount) : undefined })));
  r.post('/objects/:id/interact', actLimit, wrap(async (req) => {
    const b = req.body || {};
    const a = ACTIONS[String(b.type)];
    if (!a || (a.needs !== 'object' && a.needs !== 'target')) throw new GameError(400, 'Unknown interaction.');
    return interact(db, { userId: uid(req), type: String(b.type), objectId: int(req.params.id), targetId: b.target != null ? int(b.target) : undefined, focus: int(b.focus, 1), amount: b.amount != null ? int(b.amount) : undefined });
  }));

  // "Why does this exist?" - the full causal record of one object.
  r.get('/objects/:id/history', wrap(async (req) => {
    const o = await seen(uid(req), int(req.params.id));
    if (Number(o.obs_level) < 2) throw new GameError(403, 'You do not know it well enough yet. Observe it more closely.');
    const [owner] = o.owner_user_id ? await db.q('SELECT username FROM users WHERE id = $1', [o.owner_user_id]) : [null];
    const [finder] = o.props?.found_by ? await db.q('SELECT username FROM users WHERE id = $1', [o.props.found_by]) : [null];
    const [parent] = o.parent_id ? await db.q('SELECT id, name, type FROM objects WHERE id = $1', [o.parent_id]) : [null];
    const interactions = await db.q(
      `SELECT i.id, i.universe_tick AS tick, i.interaction_type AS type, i.outcome, us.username FROM interactions i JOIN users us ON us.id = i.user_id
        WHERE i.object_id = $1 OR i.target_object_id = $1 ORDER BY i.id DESC LIMIT 40`, [o.id]);
    const [agg] = await db.q('SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS observers FROM interactions WHERE object_id = $1 OR target_object_id = $1', [o.id]);
    const events = await db.q('SELECT universe_tick AS tick, event_type AS type, description FROM events WHERE affected_object_id = $1 ORDER BY id DESC LIMIT 20', [o.id]);
    const notes = await db.q('SELECT n.id, n.body, n.universe_tick AS tick, us.username FROM notes n JOIN users us ON us.id = n.user_id WHERE n.object_id = $1 ORDER BY n.id DESC LIMIT 20', [o.id]);
    const [uni] = await db.q('SELECT current_tick FROM universe WHERE id = 1');
    return {
      id: Number(o.id), label: labelOf(o), createdTick: o.created_tick, age: Number(uni.current_tick) - Number(o.created_tick),
      createdBy: owner?.username ?? null, foundBy: finder?.username ?? null, namedBy: o.props?.named_by ?? null,
      parent: parent ? { id: Number(parent.id), label: parent.name || `${TYPES[parent.type]?.label} #${parent.id}` } : null,
      forms: o.props?.forms || [], origin: o.props?.origin ?? null, was: o.props?.was ?? null,
      totals: { interactions: Number(agg.n), observers: Number(agg.observers) },
      interactions: interactions.map((i) => ({ id: Number(i.id), tick: i.tick, observer: i.username, verb: ACTIONS[i.type]?.verb || i.type, outcome: ACTIONS[i.type]?.outcomes[i.outcome] || i.outcome })),
      events, notes,
    };
  }));
  r.post('/objects/:id/name', actLimit, wrap(async (req) => {
    const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '\-]{1,30}$/u.test(name)) throw new GameError(400, 'Names: 2-31 letters, numbers, spaces, hyphens or apostrophes.');
    return db.tx(async (q) => {
      const [u] = await q('SELECT id, username FROM users WHERE id = $1', [uid(req)]);
      const [o] = await q('SELECT * FROM objects WHERE id = $1 FOR UPDATE', [int(req.params.id)]);
      const [ob] = await q('SELECT level FROM observations WHERE user_id = $1 AND object_id = $2', [u.id, o?.id ?? 0]);
      if (!o || !ob || Number(ob.level) < 3) throw new GameError(403, 'You can only name what you have observed closely.');
      if (o.name) throw new GameError(409, `It already has a name: ${o.name}.`);
      await q('UPDATE objects SET name = $2, props = props || $3::jsonb WHERE id = $1', [o.id, name, JSON.stringify({ named_by: u.username })]);
      const [uni] = await q('SELECT current_tick FROM universe WHERE id = 1');
      await q(`INSERT INTO events (universe_tick, event_type, description, affected_object_id, region_id, created_by_user_id, impact) VALUES ($1, 'NAMING', $2, $3, $4, $5, 'minor')`,
        [uni.current_tick, `${u.username} named ${TYPES[o.type]?.label} #${o.id}: "${name}".`, o.id, o.region_id, u.id]);
      return { ok: true, name };
    });
  }));
  r.post('/objects/:id/notes', actLimit, wrap(async (req) => {
    const body = String(req.body?.body || '').trim();
    if (body.length < 2 || body.length > 280) throw new GameError(400, 'A note is 2 to 280 characters.');
    const o = await seen(uid(req), int(req.params.id));
    if (Number(o.obs_level) < 1) throw new GameError(403, 'Observe it before you write about it.');
    const [uni] = await db.q('SELECT current_tick FROM universe WHERE id = 1');
    await db.q('INSERT INTO notes (user_id, object_id, body, universe_tick) VALUES ($1, $2, $3, $4)', [uid(req), o.id, body, uni.current_tick]);
    return { ok: true };
  }));

  r.get('/interactions/:id/verify', wrap(async (req) => verify(db, int(req.params.id), uid(req))));

  // ---- observers and what they have learned -------------------------------------
  r.get('/users/:id', wrap(async (req) => {
    const id = req.params.id === 'me' ? uid(req) : int(req.params.id);
    const u = await me(id).catch(() => { throw new GameError(404, 'No such observer.'); });
    const [uni] = await db.q('SELECT current_tick FROM universe WHERE id = 1');
    const [i] = await db.q('SELECT COUNT(*) AS n, COUNT(DISTINCT object_id) AS objects FROM interactions WHERE user_id = $1', [id]);
    const [d] = await db.q('SELECT COUNT(*) AS n FROM discoveries WHERE user_id = $1', [id]);
    const [c] = await db.q('SELECT COUNT(*) AS n FROM objects WHERE owner_user_id = $1 AND parent_id IS NULL', [id]);
    const [ev] = await db.q(`SELECT COUNT(*) AS n FROM events WHERE created_by_user_id = $1 AND impact <> 'minor'`, [id]);
    const [aff] = await db.q(
      `SELECT COUNT(DISTINCT i2.user_id) AS n FROM interactions i1 JOIN interactions i2 ON i2.object_id = i1.object_id AND i2.user_id <> i1.user_id AND i2.universe_tick > i1.universe_tick WHERE i1.user_id = $1`, [id]);
    const [reg] = await db.q('SELECT COUNT(*) AS n FROM user_regions WHERE user_id = $1', [id]);
    const [old] = await db.q(`SELECT id, name, type, created_tick FROM objects WHERE owner_user_id = $1 AND type <> 'remnant' AND state <> 'merged' ORDER BY created_tick, id LIMIT 1`, [id]);
    return {
      user: { ...publicUser(u), energy: id === uid(req) ? publicUser(u).energy : undefined, observedBy: u.stats?.observedBy ?? null },
      life: {
        arrivedTick: u.life_started_tick, currentTick: uni.current_tick, interactions: Number(i.n), discoveries: Number(d.n), objectsCreated: Number(c.n),
        objectsInfluenced: Number(i.objects), majorEvents: Number(ev.n), observersAffected: Number(aff.n), regionsExplored: Number(reg.n),
        oldestCreation: old ? { id: Number(old.id), label: old.name || `${TYPES[old.type]?.label} #${old.id}`, age: Number(uni.current_tick) - Number(old.created_tick) } : null,
      },
    };
  }));
  r.get('/users/:id/discoveries', wrap(async (req) => {
    const id = req.params.id === 'me' ? uid(req) : int(req.params.id);
    const rows = await db.q('SELECT key, discovery_type AS type, description, discovered_tick AS tick, object_id AS "objectId" FROM discoveries WHERE user_id = $1 ORDER BY id DESC', [id]);
    const u = await me(id);
    return { discoveries: rows, lawsFound: rows.filter((x) => x.type === 'law').length, lawsTotal: DISCOVERIES.length, witnessed: Object.keys(u.witnessed || {}).length,
      possibleOutcomes: Object.values(ACTIONS).reduce((s, a) => s + Object.keys(a.outcomes).length, 0), rank: rankOf(u),
      domains: KNOWLEDGE_DOMAINS.map((k) => ({ key: k, points: u.domains?.[k] || 0, level: level(u.domains?.[k] || 0) })) };
  }));
  r.get('/discoveries', wrap(async () => ({
    discoveries: await db.q(`SELECT d.description, d.discovery_type AS type, d.discovered_tick AS tick, us.username FROM discoveries d JOIN users us ON us.id = d.user_id ORDER BY d.id DESC LIMIT 40`),
  })));
  return r;
}
