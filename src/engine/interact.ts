// THE INTERACTION ENGINE
// state + rules + interaction -> possibilities -> outcome -> new state
import type { DB, Q } from '../db.js';
import { ACTIONS, LAW_EMERGENCE as EM, LAW_ENTROPY, LAW_TIME, TYPES, level, rankOf, type Ctx } from './laws.js';
import { calculateOutcomes, select, type Distribution } from './probability.js';
import { makeSeed, roll } from './rng.js';
import type { Obj } from './simulate.js';
import { project } from './simulate.js';
import { Frame, GameError, applyRegen, clamp, complexityOf, labelOf, regenDue, regionId, regionOf, round, type Holder } from './world.js';
import { canSplit, changeForm, checkThresholds, generateRegion, inRegion, maybeEpoch, nextForm, split, transform } from './emergence.js';
import { addKnowledge, evaluateDiscoveries } from './discoveries.js';

type O = Obj & Holder;
export interface Input { userId: number; type: string; objectId?: number; targetId?: number; focus?: number; amount?: number; gx?: number; gy?: number; x?: number; y?: number }
const REACH = 320;
const DISRUPTIVE = new Set(['touch', 'energize', 'draw', 'connect', 'separate', 'unmake', 'create']);

export const snap = (o: Obj | null) => o && { id: o.id, type: o.type, state: o.state, energy: o.energy, stability: round(o.stability), information: o.information, complexity: complexityOf(o) };

// What an observer is allowed to know about an object, given how well they have observed it.
export function viewObject(o: Obj, lvl: number, tick: number, regionEntropy: number, me: number) {
  const p = project(o, tick, regionEntropy);
  const v: any = { id: o.id, x: o.x, y: o.y, region: o.region_id, level: lvl, known: lvl >= 1, mine: o.owner_user_id === me, lastTick: o.last_interaction_tick };
  if (lvl >= 1) { v.type = o.type; v.typeLabel = TYPES[o.type]?.label; v.name = o.name; v.label = labelOf(o); } else v.label = `Unknown Object #${o.id}`;
  if (lvl >= 2) { v.stability = Math.round(p.stability); v.state = o.state; }
  if (lvl >= 3) { v.energy = p.energy; if (o.type === 'core') v.threshold = EM.starIgnition; }
  if (lvl >= 4) { v.information = o.information; v.complexity = complexityOf(o); v.createdTick = o.created_tick; v.was = o.props?.was; v.origin = o.props?.origin; }
  return v;
}

export const publicUser = (u: any) => ({
  id: u.id, username: u.username, energy: u.energy + regenDue(u), knowledge: u.knowledge, influence: u.influence, rank: rankOf(u),
  location: u.current_location, lifeStartedTick: u.life_started_tick, lifeState: u.life_state,
  domains: Object.fromEntries(Object.entries(u.domains || {}).map(([k, v]) => [k, { points: v, level: level(v as number) }])),
});

// The distribution as this observer can perceive it: outcomes they have never
// witnessed are unnamed, and odds are blurred until the object is well observed.
export function maskDistribution(dist: Distribution, action: string, user: any, exact: boolean) {
  const a = ACTIONS[action];
  let shown = dist.outcomes.map((o) => (exact ? o.probability : Math.max(0.05, Math.round(o.probability * 10) / 10)));
  const total = shown.reduce((s, v) => s + v, 0);
  shown = shown.map((v) => v / total);
  return {
    exact,
    outcomes: dist.outcomes.map((o, i) => ({ i, label: user.witnessed?.[`${action}:${o.outcome}`] ? a.outcomes[o.outcome] : null, p: round(shown[i], 4) })),
    modifiers: dist.modifiers,
  };
}

async function loadUser(q: Q, id: number, lock: boolean) {
  const [u] = await q(`SELECT * FROM users WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!u) throw new GameError(401, 'Unknown observer.');
  u.key = `observer:${u.id}`;
  return u as any & Holder;
}
const knows = async (q: Q, userId: number, region: string) => (await q('SELECT 1 AS x FROM user_regions WHERE user_id = $1 AND region_id = $2', [userId, region])).length > 0;
async function bondsOf(q: Q, id: number) {
  return q(`SELECT r.id, r.strength, p.id AS other_id, p.type AS other_type FROM relationships r
              JOIN objects p ON p.id IN (r.object_a, r.object_b) AND p.id <> $1
             WHERE (r.object_a = $1 OR r.object_b = $1) AND r.ended_tick IS NULL ORDER BY r.strength, r.id`, [id]);
}

// Validate the request and gather everything the laws need to know.
async function buildContext(frame: Frame, user: any, input: Input) {
  const q = frame.q;
  const action = ACTIONS[input.type];
  if (!action) throw new GameError(400, 'Unknown interaction.');
  const focus = action.focusable ? clamp(Math.floor(Number(input.focus) || 1), 1, 3) : 1;
  let amount = action.amounts ? Number(input.amount ?? action.amounts[0]) : 0;
  if (action.amounts && !action.amounts.includes(amount)) throw new GameError(400, 'That amount is not allowed.');

  let obj: O | null = null, target: O | null = null, region: any = null, bonds: any[] = [], observers = 0, regionExists = false;
  let point: { x: number; y: number } | null = null, cell: { gx: number; gy: number } | null = null;

  if (action.needs === 'object' || action.needs === 'target') {
    obj = await frame.obj(Number(input.objectId));
    if (!obj) throw new GameError(404, 'There is nothing there.');
    if (obj.state === 'merged') throw new GameError(410, 'It no longer exists on its own. It became part of something else.');
    if (!(await knows(q, user.id, obj.region_id))) throw new GameError(403, 'You have not explored that region.');
    region = await frame.region(obj.region_id);
    if (await frame.settle(obj)) return { decayed: obj, action };
    if (action.only && !action.only(obj.type)) throw new GameError(400, `You cannot ${action.label.toLowerCase()} this.`);
    bonds = await bondsOf(q, obj.id);
    observers = Number((await q('SELECT COUNT(DISTINCT user_id) AS n FROM interactions WHERE object_id = $1 AND user_id <> $2', [obj.id, user.id]))[0].n);
  }
  if (action.needs === 'target') {
    target = await frame.obj(Number(input.targetId));
    if (!target || target.state === 'merged') throw new GameError(404, 'There is nothing there to connect to.');
    if (target.id === obj!.id) throw new GameError(400, 'An object cannot be connected to itself.');
    if (!(await knows(q, user.id, target.region_id))) throw new GameError(403, 'You have not explored that region.');
    if (Math.hypot(target.x - obj!.x, target.y - obj!.y) > REACH) throw new GameError(400, 'They are too far apart to connect.');
    if (await frame.settle(target)) return { decayed: target, action };
    if (target.type === 'remnant') throw new GameError(400, 'A remnant cannot be connected.');
  }
  if (action.needs === 'region') {
    const gx = Math.floor(Number(input.gx)), gy = Math.floor(Number(input.gy));
    if (!Number.isFinite(gx) || !Number.isFinite(gy) || Math.abs(gx) > 5000 || Math.abs(gy) > 5000) throw new GameError(400, 'That is not a place.');
    cell = { gx, gy };
    if (await knows(q, user.id, regionId(gx, gy))) throw new GameError(400, 'You have already been there.');
    const near = await q('SELECT 1 AS x FROM user_regions ur JOIN regions r ON r.id = ur.region_id WHERE ur.user_id = $1 AND abs(r.gx - $2) + abs(r.gy - $3) = 1 LIMIT 1', [user.id, gx, gy]);
    if (!near.length) throw new GameError(400, 'You can only explore next to somewhere you have been.');
    region = await frame.region(regionId(gx, gy));
    regionExists = !!region;
  }
  if (action.needs === 'point') {
    const x = Number(input.x), y = Number(input.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GameError(400, 'That is not a place.');
    const { gx, gy } = regionOf(x, y);
    if (!(await knows(q, user.id, regionId(gx, gy)))) throw new GameError(403, 'You can only create inside a region you have explored.');
    region = await frame.region(regionId(gx, gy));
    point = inRegion(region.id, x, y);
  }

  const bondedToStar = bonds.some((b) => b.other_type === 'star');
  if (input.type === 'draw') {
    amount = Math.min(amount, obj!.energy - (TYPES[obj!.type]?.floor || 0));
    if (amount <= 0) throw new GameError(400, 'It has no energy to give.');
  }
  const split = !!obj && canSplit(obj);
  if (input.type === 'separate' && !bonds.length && !split) throw new GameError(400, 'There is nothing here to separate.');
  const existing = target ? bonds.find((b) => b.other_id === target!.id) : null;
  const simple = (o: Obj | null) => !!o && (o.type === 'particle' || o.type === 'cluster');
  const cost = action.cost * focus + (input.type === 'energize' ? amount : 0);

  const ctx: Ctx = {
    action: input.type,
    type: obj?.type ?? 'void', state: obj?.state ?? 'none', stability: obj ? round(obj.stability) : 50, energy: obj?.energy ?? 0,
    complexity: obj ? complexityOf(obj) : 0, information: obj?.information ?? 0,
    regionEntropy: round(region?.entropy ?? LAW_ENTROPY.baseline), regionState: region?.state ?? 'calm', converged: !!region?.converged,
    globalEntropy: round(frame.u.entropy, 2), observers, focus, amount,
    hasNextForm: !!obj && !!nextForm({ type: obj.type, energy: obj.energy + (input.type === 'energize' ? amount : 0), props: obj.props }, bondedToStar),
    canSplit: split, bonds: bonds.length, bondedToStar,
    targetType: target?.type ?? null, canMerge: simple(obj) && simple(target), existingBond: !!existing, regionExists,
  };
  return { action, obj, target, region, bonds, existing, ctx, cost, focus, amount, point, cell, bondedToStar };
}

async function obsLevel(q: Q, userId: number, objectId: number) {
  const [r] = await q('SELECT level FROM observations WHERE user_id = $1 AND object_id = $2', [userId, objectId]);
  return r ? Number(r.level) : 0;
}
const exactFor = async (q: Q, user: any, obj: Obj | null) => (obj ? (await obsLevel(q, user.id, obj.id)) >= 2 : false) || level(user.domains?.probability || 0) >= 4;

// What could happen? (read-only; changes nothing)
export async function possibilities(db: DB, input: Input) {
  const frame = await Frame.open(db.q, false);
  const user = await loadUser(db.q, input.userId, false);
  const bc = await buildContext(frame, user, input);
  if ('decayed' in bc) return { decayed: true };
  const dist = calculateOutcomes(bc.ctx);
  return { action: input.type, cost: bc.cost, ticks: bc.action.ticks, affordable: user.energy + regenDue(user) >= bc.cost, ...maskDistribution(dist, input.type, user, await exactFor(db.q, user, bc.obj)) };
}

// Something unexpected. Even this is drawn from the seed.
async function anomaly(frame: Frame, user: any, at: { x: number; y: number; region: string }, obj: O | null, seed: string) {
  const r = roll(seed, 'anomaly');
  user.stats.anomalies = (user.stats.anomalies || 0) + 1;
  if (r >= 0.95 && (user.stats.total || 0) >= 25 && !user.stats.observedBy) {
    user.stats.observedBy = frame.tick;
    await frame.event('OBSERVED', `Something observed ${user.username}.`, { userId: user.id, regionId: at.region, impact: 'major' });
    return 'For one frame, the direction reversed. Something has observed you.';
  }
  if (r < 0.35) {
    const a = roll(seed, 'an-a') * Math.PI * 2;
    const p = inRegion(at.region, at.x + Math.cos(a) * 30, at.y + Math.sin(a) * 30);
    const o = await frame.spawn({ type: 'anomaly', x: p.x, y: p.y, from: frame.vac, energy: 10, stability: 45, why: 'anomaly' });
    await frame.event('ANOMALY', `◇ An anomaly opened in the region. No interaction asked for it.`, { objectId: o.id, regionId: at.region, userId: user.id, impact: 'major' });
    return 'Something that was not there is there now.';
  }
  if (r < 0.6) {
    const got = frame.move(frame.vac, user, 15, 'anomaly');
    return `Energy arrived from a direction you cannot name. +${got}`;
  }
  if (r < 0.8 && obj) {
    const p = inRegion(obj.region_id, obj.x + (roll(seed, 'an-x') - 0.5) * 120, obj.y + (roll(seed, 'an-y') - 0.5) * 120);
    obj.x = p.x; obj.y = p.y; obj.stability = round(10 + roll(seed, 'an-s') * 80); frame.touch(obj);
    return 'It is no longer where it was, and no longer what you measured.';
  }
  addKnowledge(user, 'probability', 3);
  return 'For a moment you saw every outcome at once. You understand a little more.';
}

export async function interact(db: DB, input: Input) {
  return db.tx(async (q) => {
    const frame = await Frame.open(q, true);
    const user = await loadUser(q, input.userId, true);
    if (user.life_state !== 'alive') throw new GameError(403, 'An echo can watch, but it can no longer act.');
    applyRegen(frame, user);
    user.stats = { total: 0, actions: {}, outcomes: {}, ...user.stats };
    const energyBefore = user.energy;
    const bc = await buildContext(frame, user, input);
    const saveUser = () => q(
      `UPDATE users SET energy=$2, energy_updated_at=$3, knowledge=$4, influence=$5, current_location=$6, domains=$7::jsonb, stats=$8::jsonb, witnessed=$9::jsonb, last_seen=now() WHERE id=$1`,
      [user.id, user.energy, user.energy_updated_at, user.knowledge, user.influence, user.current_location, JSON.stringify(user.domains || {}), JSON.stringify(user.stats), JSON.stringify(user.witnessed || {})]);

    if ('decayed' in bc) {   // it decayed before this observer reached it; that is now part of history
      user.stats.collapses = (user.stats.collapses || 0) + 1;
      const o = bc.decayed!;
      const lvl = Math.max(1, await obsLevel(q, user.id, o.id));
      const view = viewObject(o, lvl, frame.tick, 0, user.id);
      const newDiscoveries = await evaluateDiscoveries(q, user, frame.tick, o.id);
      await frame.flush(); await saveUser();
      return { decayed: true, narrative: 'It decayed before you reached it. Only a remnant is left.', object: view, user: publicUser(user), universeTick: frame.tick, newDiscoveries };
    }
    const { action, obj, target, ctx, cost, focus, amount, bondedToStar } = bc;
    let region = bc.region;
    if (user.energy < cost) throw new GameError(400, `Not enough energy. This needs ${cost}, you hold ${user.energy}.`);

    const lvlBefore = obj ? await obsLevel(q, user.id, obj.id) : 0;
    const exact = await exactFor(q, user, obj);
    const before = obj ? viewObject(obj, lvlBefore, frame.t0, 0, user.id) : null;

    // possibilities -> outcome
    const dist = calculateOutcomes(ctx);
    const [{ id: interactionId }] = await q(`SELECT nextval('interactions_id_seq') AS id`);
    const stateBefore = { object: snap(obj), target: snap(target), region: region ? { id: region.id, entropy: round(region.entropy), state: region.state } : null };
    const seedInput = { focus, amount, target: target?.id ?? null, gx: bc.cell?.gx ?? null, gy: bc.cell?.gy ?? null, x: bc.point?.x ?? null, y: bc.point?.y ?? null };
    const seed = makeSeed({ interactionId: Number(interactionId), stateBefore, objectId: obj?.id ?? null, userId: user.id, tick: frame.t0, type: input.type, input: seedInput });
    const r = roll(seed);
    const outcome = select(dist.outcomes, r);
    const index = dist.outcomes.findIndex((o) => o.outcome === outcome);
    const at = (r - dist.outcomes.slice(0, index).reduce((s, o) => s + o.probability, 0)) / dist.outcomes[index].probability;
    const masked = maskDistribution(dist, input.type, user, exact);

    // outcome -> new state
    frame.tick = frame.t0 + action.ticks;
    if (input.type === 'energize') frame.move(user, obj!, amount, 'gift');
    else if (input.type !== 'create') frame.move(user, frame.vac, cost, 'effort');
    let say = action.outcomes[outcome] + '.';
    let levelGain = 0, formChanged = false, more: string | null = null;
    const bump = (o: O, d: number) => { o.stability = round(clamp(o.stability + d, 0, 100)); frame.touch(o); };
    const here = obj ? { x: obj.x, y: obj.y, region: obj.region_id } : bc.point ? { ...bc.point, region: region.id } : null;
    const doTransform = async () => { const t = await transform(frame, obj!, user.id, bondedToStar); say = t.say; formChanged = !!t.form; };
    const doSplit = async () => { const c = await split(frame, obj!, seed, user.id); await q('INSERT INTO observations (user_id, object_id, level, count, first_tick) VALUES ($1,$2,1,0,$3) ON CONFLICT DO NOTHING', [user.id, c.id, frame.tick]); say = `It split. A ${TYPES[c.type].label.toLowerCase()} carrying ${c.energy} energy now exists beside it.`; };

    switch (`${input.type}:${outcome}`) {
      case 'observe:clear': levelGain = 1; say = 'It held still under your attention. You know more about it.'; break;
      case 'observe:deep': levelGain = 2; say = 'You saw further into it than you expected.'; break;
      case 'observe:perturb': { levelGain = 1; const d = round((roll(seed, 'perturb') - 0.5) * 14, 1); bump(obj!, d); say = `Your looking changed it. Its stability shifted by ${d > 0 ? '+' : ''}${d}.`; break; }
      case 'observe:elusive': say = 'It would not resolve. You learned nothing this time.'; break;

      case 'touch:stabilize': bump(obj!, 8 + 3 * (focus - 1)); say = 'It settled under your touch.'; break;
      case 'energize:absorb': bump(obj!, 2); say = `It absorbed all ${amount} energy.`; break;
      case 'energize:excite': bump(obj!, -8); obj!.state = 'excited'; say = `It took the ${amount} energy and became excited. Excited things decay faster.`; break;
      case 'touch:transform': case 'energize:transform': await doTransform(); break;
      case 'touch:split': case 'energize:split': case 'separate:split': await doSplit(); break;

      case 'draw:clean': say = `A clean transfer. +${frame.move(obj!, user, amount, 'draw')} energy.`; break;
      case 'draw:leak': { const got = frame.move(obj!, user, Math.ceil(amount / 2), 'draw'); const lost = frame.move(obj!, frame.vac, Math.floor(amount / 2), 'leak'); say = `You caught ${got}. ${lost} leaked into the vacuum.`; break; }
      case 'draw:destabilize': { const got = frame.move(obj!, user, amount, 'draw'); bump(obj!, -15); obj!.state = 'excited'; say = `+${got} energy, but you left it shaking.`; break; }
      case 'draw:collapse': { const got = frame.move(obj!, user, amount, 'draw'); user.stats.collapses = (user.stats.collapses || 0) + 1; await frame.collapse(obj!, `${user.username} drew out what was holding it together.`, user.id); say = `+${got} energy. It could not survive the loss and collapsed.`; break; }

      case 'connect:bond': {
        if (bc.existing) { await q('UPDATE relationships SET strength = strength + 1 WHERE id = $1', [bc.existing.id]); say = 'The bond between them grew stronger.'; }
        else { await q('INSERT INTO relationships (object_a, object_b, relationship_type, strength, created_tick) VALUES ($1, $2, $3, $4, $5)', [obj!.id, target!.id, 'bond', focus, frame.tick]); say = 'A bond formed. They will share their fate from here.'; }
        bump(obj!, 3); bump(target!, 3); break;
      }
      case 'connect:resonance': bump(obj!, 10); bump(target!, 10); obj!.state = target!.state = 'resonant'; say = 'They began to resonate. Both are steadier, and stranger.'; break;
      case 'connect:repel': {
        const dx = obj!.x - target!.x, dy = obj!.y - target!.y, d = Math.hypot(dx, dy) || 1;
        Object.assign(obj!, inRegion(obj!.region_id, obj!.x + (dx / d) * 30, obj!.y + (dy / d) * 30));
        Object.assign(target!, inRegion(target!.region_id, target!.x - (dx / d) * 30, target!.y - (dy / d) * 30));
        bump(obj!, -5); bump(target!, -5); say = 'They pushed each other away.'; break;
      }
      case 'connect:merge': {
        const B = target!;
        frame.move(B, obj!, B.energy, 'merge');
        obj!.props = { ...obj!.props, complexity: complexityOf(obj!) + complexityOf(B), merged: [...(obj!.props.merged || []), B.id] };
        obj!.information += B.information;
        if (obj!.type === 'particle') obj!.type = 'cluster';
        obj!.stability = round(clamp((obj!.stability + B.stability) / 2 + 5, 0, 100));
        B.state = 'merged'; B.props = { ...B.props, merged_into: obj!.id, ended_tick: frame.tick };
        frame.touch(obj!); frame.touch(B);
        await q('UPDATE relationships SET ended_tick = $2 WHERE (object_a = $1 OR object_b = $1) AND ended_tick IS NULL', [B.id, frame.tick]);
        await frame.event('MERGE', `Two objects merged into ${labelOf(obj!)}.`, { objectId: obj!.id, regionId: obj!.region_id, userId: user.id, data: { absorbed: B.id } });
        say = `They merged into one ${TYPES[obj!.type].label.toLowerCase()}. Its complexity is now ${complexityOf(obj!)}.`; break;
      }

      case 'separate:break': { const b = bc.bonds[0]; await q('UPDATE relationships SET ended_tick = $2 WHERE id = $1', [b.id, frame.tick]); bump(obj!, -4); say = 'A bond broke. They are on their own again.'; break; }
      case 'separate:holds': say = 'It held together.'; break;

      case 'stabilize:settle': bump(obj!, 15 + 4 * (focus - 1)); obj!.state = 'calm'; say = 'It settled. The disorder you removed went somewhere else.'; break;
      case 'stabilize:lock': bump(obj!, 30); obj!.state = 'calm'; say = 'It locked into a deep, ordered calm.'; break;
      case 'stabilize:nothing': say = 'Nothing changed. The energy is gone all the same.'; break;
      case 'stabilize:backfire': bump(obj!, -8); obj!.state = 'excited'; say = 'It backfired. Your order became its disorder.'; break;

      case 'signal:silence': say = 'Silence.'; break;
      case 'signal:reacts': bump(obj!, round((roll(seed, 'react') - 0.5) * 20, 1)); obj!.state = 'excited'; say = 'It reacted. It is not clear that it understood.'; break;
      case 'signal:adapts': obj!.props = { ...obj!.props, complexity: complexityOf(obj!) + 5 }; bump(obj!, 5); say = 'It changed its behaviour in response. It is slightly more complex now.'; break;
      case 'signal:reply': {
        addKnowledge(user, 'life', 2); say = 'It answered. You do not know what it said.';
        if (obj!.type === 'intelligence' && !user.stats.observedBy) { user.stats.observedBy = frame.tick; say = 'It answered. Then: something has observed you.'; await frame.event('OBSERVED', `Something observed ${user.username}.`, { userId: user.id, objectId: obj!.id, regionId: obj!.region_id, impact: 'major' }); }
        break;
      }

      case 'unmake:unmade': user.stats.collapses = (user.stats.collapses || 0) + 1; await frame.collapse(obj!, `${user.username} unmade it.`, user.id); say = 'It is gone. Its energy returned to the vacuum. Its history did not.'; break;
      case 'unmake:resists': bump(obj!, 3); say = 'It resisted. What has a long history is hard to erase.'; break;
      case 'unmake:burst': {
        const near = frame.adopt(await q(`SELECT * FROM objects WHERE region_id = $1 AND id <> $2 AND state <> 'merged' AND type <> 'remnant' ORDER BY (x-$3)*(x-$3)+(y-$4)*(y-$4) LIMIT 5 FOR UPDATE`, [obj!.region_id, obj!.id, obj!.x, obj!.y]));
        const share = near.length ? Math.floor(obj!.energy / near.length) : 0;
        for (const nb of near) { frame.move(obj!, nb, share, 'burst'); bump(nb, -4); }
        user.stats.collapses = (user.stats.collapses || 0) + 1;
        await frame.collapse(obj!, 'It burst and scattered its energy.', user.id);
        say = near.length ? `It burst. Its energy scattered into ${near.length} nearby object${near.length === 1 ? '' : 's'}.` : 'It burst into the vacuum.'; break;
      }

      case 'create:particle': case 'create:dust': case 'create:field': {
        frame.move(user, frame.vac, 5, 'effort');
        const made = await frame.spawn({ type: outcome, x: bc.point!.x, y: bc.point!.y, from: user, energy: 20, stability: 45 + roll(seed, 'c-stab') * 30, owner: user.id, why: 'creation' });
        user.stats.created = (user.stats.created || 0) + 1;
        await q('INSERT INTO observations (user_id, object_id, level, count, first_tick) VALUES ($1,$2,2,0,$3) ON CONFLICT DO NOTHING', [user.id, made.id, frame.tick]);
        await frame.event('CREATION', `✦ ${user.username} created a ${TYPES[outcome].label.toLowerCase()}.`, { objectId: made.id, regionId: made.region_id, userId: user.id });
        say = `Something exists that did not exist one frame ago: a ${TYPES[outcome].label.toLowerCase()}, holding 20 of your energy.`; break;
      }
      case 'create:fizzle': frame.move(user, frame.vac, cost, 'effort'); say = 'It faded before it formed. The energy returned to the vacuum.'; break;

      case 'explore:arrival': say = 'This region already had a state. Someone was here before you.'; break;
      default:
        if (outcome === 'anomaly') {
          if (input.type === 'create') frame.move(user, frame.vac, cost, 'effort');
          if (input.type === 'explore') { const g = await generateRegion(frame, bc.cell!.gx, bc.cell!.gy, 'anomaly', seed, user.id); region = g.region; say = 'The region resolved into something that should not be there.'; }
          else say = await anomaly(frame, user, here!, obj, seed);
        } else if (input.type === 'explore') {
          const g = await generateRegion(frame, bc.cell!.gx, bc.cell!.gy, outcome, seed, user.id); region = g.region;
          say = g.made.length ? `Until now this region had no state. Now it holds ${g.made.length} thing${g.made.length === 1 ? '' : 's'}.` : 'Until now this region had no state. Now it is empty, and that is a fact.';
        }
    }

    if (input.type === 'explore') {
      await q('INSERT INTO user_regions (user_id, region_id, discovered_tick) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [user.id, region.id, frame.tick]);
      if (outcome !== 'arrival') await frame.event('EXPLORATION', `🔭 ${user.username} gave Region ${region.num} its first state.`, { regionId: region.id, userId: user.id });
      user.current_location = region.id;
    }

    // thresholds, entropy and the wider consequences
    for (const o of [obj, target]) if (o && o.type !== 'remnant' && o.state !== 'merged') { const t = await checkThresholds(frame, o, user.id); if (t) { more = t; formChanged = true; } }
    if (obj) {
      const gain = outcome === 'elusive' ? 0 : ['clear', 'absorb', 'clean', 'holds', 'silence', 'nothing'].includes(outcome) ? 1 : 2;
      obj.information += gain; frame.info += gain; obj.last_interaction_tick = frame.tick; frame.touch(obj);
      if (target) { target.information += 1; frame.info += 1; target.last_interaction_tick = frame.tick; frame.touch(target); }
      user.current_location = obj.region_id;
      if (obj.owner_user_id && obj.owner_user_id !== user.id) await q('UPDATE users SET influence = influence + 1 WHERE id = $1', [obj.owner_user_id]);
      if (ctx.observers > 0) user.stats.shared = (user.stats.shared || 0) + 1;
    }
    if (region) {
      region.interaction_count = Number(region.interaction_count) + 1;
      if (DISRUPTIVE.has(input.type)) region.entropy += LAW_ENTROPY.perInteraction;
      if (outcome === 'settle' || outcome === 'lock') { region.entropy = Math.max(0, region.entropy + LAW_ENTROPY.stabilizeLocal); frame.u.entropy += LAW_ENTROPY.stabilizeGlobal; }
      frame.touchRegion(region);
      if (region.state !== 'unstable' && region.entropy > LAW_ENTROPY.unstableAbove) {
        region.state = 'unstable';
        await frame.event('INSTABILITY', `🌌 Region ${region.num} entered instability.`, { regionId: region.id, userId: user.id, impact: 'major' });
      }
      if (!region.converged && input.type !== 'explore') {
        const rows = await q('SELECT DISTINCT user_id FROM interactions WHERE region_id = $1 AND universe_tick > $2', [region.id, frame.tick - LAW_TIME.convergenceWindow]);
        const ids = new Set(rows.map((x) => Number(x.user_id))); ids.add(user.id);
        if (ids.size >= EM.convergenceObservers) {
          region.converged = true;
          await q(`UPDATE objects SET stability = LEAST(100, stability + 10) WHERE region_id = $1 AND state <> 'merged' AND type <> 'remnant'`, [region.id]);
          for (const o of frame.objs.values()) if (o.region_id === region.id && o.type !== 'remnant') o.stability = Math.min(100, o.stability + 10);
          await frame.event('CONVERGENCE', `🔭 Convergence. ${ids.size} observers have interacted with Region ${region.num}. It will not be the same again.`, { regionId: region.id, userId: user.id, impact: 'major', data: { observers: ids.size } });
          more = (more ? more + ' ' : '') + 'Multiple observers have interacted with the same region of reality.';
        }
      }
    }
    if (input.type === 'energize' && obj && !obj.props.collective) {
      const rows = await q(`SELECT DISTINCT user_id FROM interactions WHERE object_id = $1 AND interaction_type = 'energize'`, [obj.id]);
      const ids = new Set(rows.map((x) => Number(x.user_id))); ids.add(user.id);
      if (ids.size >= EM.collectiveObservers) {
        obj.props = { ...obj.props, collective: frame.tick }; frame.touch(obj);
        await frame.event('COLLECTIVE', `⚡ Collective energy event. ${ids.size} observers are feeding ${labelOf(obj)}.`, { objectId: obj.id, regionId: obj.region_id, userId: user.id, impact: 'major' });
      }
    }

    // what the observer learned
    const key = `${input.type}:${outcome}`;
    const firstTime = !user.witnessed?.[key];
    if (firstTime) { user.witnessed = { ...user.witnessed, [key]: frame.tick }; addKnowledge(user, action.domain, 1); }
    const s = user.stats;
    s.total += 1; s.actions[input.type] = (s.actions[input.type] || 0) + 1; s.outcomes[key] = (s.outcomes[key] || 0) + 1;
    if (focus > 1) s.focused = (s.focused || 0) + 1;
    if (formChanged) s.formChanges = (s.formChanges || 0) + 1;
    if (ctx.stability < 25 && obj && (outcome === 'transform' || outcome === 'split')) s.lowStabChange = (s.lowStabChange || 0) + 1;
    let lvlAfter = lvlBefore;
    if (obj) {
      lvlAfter = Math.min(4, Math.max(1, lvlBefore + levelGain));
      await q(`INSERT INTO observations (user_id, object_id, level, count, first_tick) VALUES ($1, $2, $3, 1, $4)
               ON CONFLICT (user_id, object_id) DO UPDATE SET level = GREATEST(observations.level, $3), count = observations.count + 1`, [user.id, obj.id, lvlAfter, frame.tick]);
      if (lvlBefore === 0) {
        const [seen] = await q(`SELECT 1 AS x FROM events WHERE event_type = 'DISCOVERY' AND data->>'kind' = $1 LIMIT 1`, [obj.props.was || obj.type]);
        if (!seen && !['particle', 'remnant'].includes(obj.type)) {
          await frame.event('DISCOVERY', `👤 ${user.username} discovered a previously unknown kind of structure.`, { objectId: obj.id, regionId: obj.region_id, userId: user.id, impact: 'major', data: { kind: obj.type } });
          await q('INSERT INTO discoveries (user_id, discovery_type, key, object_id, description, discovered_tick) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
            [user.id, 'first', `first:${obj.type}`, obj.id, `First observer in this universe to identify a ${TYPES[obj.type].label}.`, frame.tick]);
          addKnowledge(user, 'probability', 2);
        }
      }
    }
    const rankBefore = rankOf({ ...user, stats: { ...s, total: s.total - 1 } });
    const newDiscoveries = await evaluateDiscoveries(q, user, frame.tick, obj?.id ?? null);

    // the immutable record
    const spawned = frame.spawned.slice();
    const stateAfter = { object: snap(obj), target: snap(target), created: spawned.map(snap), region: region ? { id: region.id, entropy: round(region.entropy), state: region.state } : null };
    const transfers = frame.transfers.slice();
    const events = frame.events.slice();
    await q(
      `INSERT INTO interactions (id, user_id, object_id, target_object_id, region_id, interaction_type, energy_before, energy_spent, state_before, probability_data, outcome, state_after, transfers, universe_tick, seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13::jsonb,$14,$15)`,
      [interactionId, user.id, obj?.id ?? spawned[0]?.id ?? null, target?.id ?? null, region?.id ?? null, input.type, energyBefore, cost, JSON.stringify(stateBefore),
        JSON.stringify({ ctx, outcomes: dist.outcomes, modifiers: dist.modifiers, roll: r, tick_before: frame.t0, input: seedInput }), outcome, JSON.stringify(stateAfter), JSON.stringify(transfers), frame.tick, seed]);

    const objView = obj ? viewObject(obj, lvlAfter, frame.tick, 0, user.id) : null;
    const created = spawned.map((o) => viewObject(o, o.owner_user_id === user.id || o.parent_id ? 1 : 0, frame.tick, 0, user.id));
    await maybeEpoch(frame);
    await frame.flush();
    await saveUser();
    const rank = rankOf(user);
    return {
      interactionId: Number(interactionId), universeTick: frame.tick, action: input.type, outcome, outcomeLabel: action.outcomes[outcome], narrative: say, more,
      roll: r, seed, chosen: index, at, distribution: masked, firstTime, energySpent: cost, energyDelta: user.energy - energyBefore,
      before, object: objView, created, region: region ? { id: region.id, num: region.num, gx: region.gx, gy: region.gy } : null,
      newDiscoveries, events: events.filter((e) => e.impact !== 'minor'), rankUp: rank !== rankBefore ? rank : null, user: publicUser(user),
    };
  });
}

// Re-derive a past outcome from the record alone. Same state + same interaction = same outcome.
export async function verify(db: DB, id: number, userId: number) {
  const [i] = await db.q('SELECT * FROM interactions WHERE id = $1', [id]);
  if (!i) throw new GameError(404, 'No such interaction.');
  const pd = i.probability_data;
  const dist = calculateOutcomes(pd.ctx);
  const seed = makeSeed({ interactionId: Number(i.id), stateBefore: i.state_before, objectId: pd.ctx.type === 'void' ? null : i.object_id, userId: Number(i.user_id), tick: pd.tick_before, type: i.interaction_type, input: pd.input });
  const r = roll(seed);
  const outcome = select(dist.outcomes, r);
  const sameDist = JSON.stringify(dist.outcomes.map((o) => [o.outcome, round(o.probability, 9)])) === JSON.stringify(pd.outcomes.map((o: any) => [o.outcome, round(o.probability, 9)]));
  const ok = seed === i.seed && outcome === i.outcome && sameDist;
  if (ok && Number(i.user_id) === userId) {
    await db.tx(async (q) => {
      const user = await loadUser(q, userId, true);
      user.stats = { ...user.stats, verified: (user.stats.verified || 0) + 1 };
      const [u] = await q('SELECT current_tick FROM universe WHERE id = 1');
      await evaluateDiscoveries(q, user, u.current_tick, i.object_id);
      await q('UPDATE users SET stats=$2::jsonb, domains=$3::jsonb, knowledge=$4 WHERE id=$1', [userId, JSON.stringify(user.stats), JSON.stringify(user.domains || {}), user.knowledge]);
    });
  }
  return { ok, interactionId: Number(i.id), recorded: { seed: i.seed, outcome: i.outcome, roll: pd.roll }, rederived: { seed, outcome, roll: r }, sameDistribution: sameDist };
}

// The universe moves even when nobody acts.
export async function heartbeat(db: DB, ticks: number) {
  return db.tx(async (q) => {
    const frame = await Frame.open(q, true);
    frame.tick = frame.t0 + ticks;
    await maybeEpoch(frame);
    await frame.flush();
    return frame.tick;
  });
}
export { changeForm };
