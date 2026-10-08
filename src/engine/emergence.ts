// LAW_EMERGENCE / LAW_REPLICATION / LAW_DECAY in motion: thresholds, new forms,
// life, and the slow background evolution that happens once per epoch.
import { LAW_EMERGENCE as EM, LAW_ENTROPY, LAW_GRAVITY, LAW_REPLICATION as REP, LAW_TIME, REGION_SIZE, TYPES } from './laws.js';
import { roll, sha } from './rng.js';
import type { Obj } from './simulate.js';
import { Frame, baseComplexity, clamp, complexityOf, labelOf, regionOf, round, type Holder } from './world.js';

type O = Obj & Holder;
const F = EM.forms;

// What an object would become if it changed form right now (null: it would only change phase).
export function nextForm(o: { type: string; energy: number; props: any }, bondedToStar: boolean): string | null {
  const c = Number(o.props?.complexity ?? 1);
  switch (o.type) {
    case 'remnant': return o.energy >= F.remnantToParticle ? 'particle' : null;
    case 'particle': return o.energy >= F.particleToField ? 'field' : null;
    case 'field': return o.energy >= F.fieldToDust ? 'dust' : null;
    case 'cluster':
      if (bondedToStar && o.energy >= F.toPlanet) return 'planet';
      return o.energy >= F.clusterToDust && c >= F.clusterComplexity ? 'dust' : null;
    case 'dust':
      if (bondedToStar && o.energy >= F.toPlanet) return 'planet';
      return o.energy >= F.dustToCore ? 'core' : null;
    case 'anomaly': return 'particle';
    case 'replicator': return c >= F.replicatorToOrganism ? 'organism' : null;
    case 'organism': return c >= F.organismToEcosystem && (o.props?.replications || 0) >= 3 ? 'ecosystem' : null;
    case 'ecosystem': return c >= F.ecosystemToIntelligence ? 'intelligence' : null;
    default: return null;
  }
}

export const canSplit = (o: { type: string; energy: number }) =>
  (['particle', 'cluster', 'dust', 'field'].includes(o.type) && o.energy >= 6) || (['replicator', 'organism'].includes(o.type) && o.energy >= 40);

const ICON: Record<string, string> = { star: '⭐', planet: '🪐', core: '🌑', replicator: '🧬', organism: '🧬', ecosystem: '🌿', intelligence: '🏛️', singularity: '⚫' };
const BIG = new Set(['core', 'star', 'planet', 'replicator', 'organism', 'ecosystem', 'intelligence', 'singularity']);

export async function changeForm(frame: Frame, o: O, to: string, userId: number | null, note = '', quiet = false) {
  const from = o.type;
  const before = labelOf(o);
  o.props = { ...o.props, complexity: Math.max(complexityOf(o), baseComplexity(to)), forms: [...(o.props.forms || []), { from, to, tick: frame.tick }] };
  o.type = to;
  o.state = to === 'core' ? 'dormant' : 'calm';
  o.stability = clamp(o.stability + 20, 30, 100);
  o.information += 5; frame.info += 5;
  frame.touch(o);
  const label = TYPES[to].label;
  const [seen] = await frame.q(`SELECT 1 AS x FROM events WHERE event_type = 'FIRST' AND data->>'kind' = $1 LIMIT 1`, [to]);
  if (!seen && BIG.has(to)) {
    await frame.event('FIRST', `${ICON[to] || '✦'} The first ${label} in this universe has emerged.`, { objectId: o.id, regionId: o.region_id, userId, impact: 'cosmic', data: { kind: to } });
  }
  if (!quiet) await frame.event('TRANSFORMATION', `${before} became a ${label}.${note ? ' ' + note : ''}`, { objectId: o.id, regionId: o.region_id, userId, impact: BIG.has(to) ? 'major' : 'minor', data: { from, to } });
  return { from, to, first: !seen && BIG.has(to) };
}

// A change of state: a new form if the object is ready for one, otherwise a new phase.
export async function transform(frame: Frame, o: O, userId: number | null, bondedToStar: boolean) {
  const to = nextForm(o, bondedToStar);
  if (to) return { form: await changeForm(frame, o, to, userId), say: `It crossed a threshold and became a ${TYPES[to].label}.` };
  const phases = ['calm', 'excited', 'resonant'];
  const i = phases.indexOf(o.state);
  o.state = phases[(i + 1) % phases.length];
  o.stability = clamp(o.stability + (o.state === 'excited' ? -6 : 4), 1, 100);
  frame.touch(o);
  return { form: null, say: `Its state shifted. It is now ${o.state}.` };
}

export async function split(frame: Frame, o: O, seed: string, userId: number | null) {
  const life = !!TYPES[o.type]?.life;
  const a = roll(seed, 'split-angle') * Math.PI * 2;
  const d = 18 + roll(seed, 'split-dist') * 14;
  const p = inRegion(o.region_id, o.x + Math.cos(a) * d, o.y + Math.sin(a) * d);
  const c = complexityOf(o);
  const child = await frame.spawn({ type: life ? o.type : 'particle', x: p.x, y: p.y, from: o, energy: Math.floor(o.energy * 0.4), stability: 50, parent: o.id, owner: userId, why: life ? 'replication' : 'split',
    props: life ? { complexity: Math.max(baseComplexity(o.type), Math.floor(c * 0.8)) } : {} });
  if (life) o.props = { ...o.props, replications: (o.props.replications || 0) + 1 };
  else if (o.type === 'cluster') {
    o.props = { ...o.props, complexity: Math.max(1, c - 1) };
    if (o.props.complexity <= 1) o.type = 'particle';
  }
  o.stability = clamp(o.stability - 5, 1, 100);
  frame.touch(o);
  return child;
}

export function inRegion(region: string, x: number, y: number) {
  const [gx, gy] = region.split(':').map(Number);
  return { x: round(clamp(x, gx * REGION_SIZE + 10, (gx + 1) * REGION_SIZE - 10), 2), y: round(clamp(y, gy * REGION_SIZE + 10, (gy + 1) * REGION_SIZE - 10), 2) };
}

// Deterministic thresholds: no dice, only accumulated energy.
export async function checkThresholds(frame: Frame, o: O, userId: number | null) {
  if (o.type === 'core' && o.energy >= EM.starIgnition) {
    const rows = await frame.q(`SELECT user_id, MIN(universe_tick) AS first FROM interactions WHERE object_id = $1 AND interaction_type = 'energize' GROUP BY user_id`, [o.id]);
    const ids = new Set(rows.map((r) => Number(r.user_id)));
    if (userId) ids.add(userId);
    const observers = ids.size;
    const h = { first: rows.length ? Math.min(...rows.map((r) => Number(r.first))) : null };
    const span = frame.tick - Number(h.first ?? o.created_tick);
    const note = observers === 0 ? 'It gathered itself out of dust. No observer fed it.'
      : `This star emerged after ${observers} observer${observers === 1 ? '' : 's'} contributed energy across ${span.toLocaleString('en-US')} universe ticks.`;
    // How long it will live is settled at birth: a giant burns out in days, a dwarf lasts months.
    const sb = sha(`star:${o.id}`);
    const giant = roll(sb, 'giant') < LAW_GRAVITY.giantChance;
    const [lo, hi] = giant ? LAW_GRAVITY.giantLifeDays : LAW_GRAVITY.dwarfLifeDays;
    const lifeDays = lo + roll(sb, 'life') * (hi - lo);
    const burn = round(o.energy / (lifeDays * (LAW_GRAVITY.ticksPerDay / 100)), 4);
    o.props = { ...o.props, origin: note, rt: frame.tick, gen: o.props.gen ?? o.props.enriched ?? 0, burn, giant };
    await changeForm(frame, o, 'star', userId, '', true);
    const [reg] = await frame.q('SELECT num FROM regions WHERE id = $1', [o.region_id]);
    await frame.event('STAR_IGNITION', `⭐ A new star was born in Region ${reg?.num}. ${note}`, { objectId: o.id, regionId: o.region_id, userId, impact: observers ? 'cosmic' : 'major', data: { observers, span } });
    return `The core ignited. ${note}`;
  }
  if (o.type === 'star' && o.energy >= EM.singularity) {
    await changeForm(frame, o, 'singularity', userId, 'It held more energy than a star can hold.');
    return 'Too much. The star folded inward into a singularity.';
  }
  if (o.type === 'star' && o.energy <= EM.starDeath) {
    await supernova(frame, o, userId);
    return 'The star died. What it made in its lifetime is now scattered around it.';
  }
  return null;
}

// ---- the epoch: slow background evolution, run when the clock crosses a boundary ----
// A star's death is not an ending. It scatters dust richer than the dust it was made from.
export async function supernova(frame: Frame, o: O, userId: number | null) {
  const gen = (o.props?.gen || 0) + 1;
  const s = sha(`supernova:${o.id}:${frame.tick}`);
  const [lo, hi] = LAW_GRAVITY.supernovaDust;
  const n = lo + Math.floor(roll(s, 'n') * (hi - lo + 1));
  const label = labelOf(o);
  for (let i = 0; i < n; i++) {
    const a = roll(s, 'a' + i) * Math.PI * 2, d = 35 + roll(s, 'd' + i) * 45;
    const p = inRegion(o.region_id, o.x + Math.cos(a) * d, o.y + Math.sin(a) * d);
    const dust = await frame.spawn({ type: 'dust', x: p.x, y: p.y, from: frame.vac, energy: 30 + Math.floor(roll(s, 'e' + i) * 40), stability: 55, parent: o.id, why: 'supernova',
      props: { enriched: gen, complexity: 5 + 8 * gen } });
    frame.move(o, dust, Math.floor(o.energy / (n - i)), 'supernova');
  }
  await frame.event('SUPERNOVA', `💥 ${label} died. It scattered ${n} clouds of enriched dust (generation ${gen}).`, { objectId: o.id, regionId: o.region_id, userId, impact: 'major', data: { gen } });
  await frame.collapse(o, 'It burned through everything it had.', userId);
}

export async function maybeEpoch(frame: Frame, extra?: (frame: Frame, epoch: number, n: number) => Promise<void>) {
  const E = LAW_TIME.epochTicks;
  const n = Math.min(10, Math.floor(frame.tick / E) - Math.floor(frame.u.last_epoch / E));
  if (n <= 0) return;
  await frame.flush();
  frame.u.last_epoch = frame.tick;
  frame.t0 = frame.tick;
  const epoch = Math.floor(frame.tick / E);
  const q = frame.q;

  // LAW_ENTROPY: the whole universe ages; regions relax.
  frame.u.entropy = round(frame.u.entropy + LAW_ENTROPY.epochGlobal * n, 5);
  await q('UPDATE regions SET entropy = GREATEST($1, entropy - $2) WHERE entropy > $1', [LAW_ENTROPY.baseline, LAW_ENTROPY.epochRelax * n]);
  for (const r of await q(`UPDATE regions SET state = 'calm' WHERE state = 'unstable' AND entropy < $1 RETURNING id, num`, [LAW_ENTROPY.calmBelow])) {
    await frame.event('STABILITY', `Region ${r.num} settled back into calm.`, { regionId: r.id, impact: 'minor' });
  }

  // LAW_DECAY: the longest-unattended fragile things are brought up to date. Some do not survive.
  const fragile = Object.keys(TYPES).filter((t) => TYPES[t].decay > 0).map((t) => `'${t}'`).join(',');
  for (const o of frame.adopt(await q(`SELECT * FROM objects WHERE state <> 'merged' AND type IN (${fragile}) ORDER BY last_sim_tick ASC LIMIT 40 FOR UPDATE`))) await frame.settle(o);

  // Stars feed what is bonded to them.
  const fed = await q(
    `SELECT r.id, s.id AS star_id, p.id AS other_id FROM relationships r
       JOIN objects s ON s.id IN (r.object_a, r.object_b) AND s.type = 'star'
       JOIN objects p ON p.id IN (r.object_a, r.object_b) AND p.id <> s.id AND p.state <> 'merged' AND p.type <> 'remnant'
      WHERE r.ended_tick IS NULL ORDER BY r.id LIMIT 40`);
  for (const f of fed) {
    const star = await frame.obj(f.star_id), p = await frame.obj(f.other_id);
    if (!star || !p || star.type !== 'star') continue;
    await frame.settle(star);
    if (star.energy > 200) frame.move(star, p, REP.starFeed * n, 'starlight');
    p.stability = clamp(p.stability + 2, 0, 100);
    // Enriched dust held and warmed by a star can settle into a world.
    if ((p.type === 'dust' || p.type === 'cluster') && p.props?.enriched && nextForm(p, true) === 'planet' && roll(sha(`epoch:${epoch}:planet:${p.id}`)) < LAW_GRAVITY.planetChance) {
      await changeForm(frame, p, 'planet', null, 'It settled out of enriched dust around its star.');
    }
    if (p.type === 'planet') {
      p.props = { ...p.props, complexity: complexityOf(p) + n };
      // LAW_EMERGENCE: on a warm, complex, steady world, something may begin to copy itself.
      if (!p.props.life && complexityOf(p) >= EM.lifeComplexity && p.stability >= 40 && p.stability <= 92 && p.energy >= 60) {
        const [w] = await q('SELECT COUNT(DISTINCT user_id) AS n FROM interactions WHERE object_id = $1', [p.id]);
        const chance = EM.lifeChance * n + EM.lifePerObserver * Number(w.n);
        if (roll(sha(`epoch:${epoch}:life:${p.id}`)) < chance) {
          const a = roll(sha(`epoch:${epoch}:pos:${p.id}`)) * Math.PI * 2;
          const pos = inRegion(p.region_id, p.x + Math.cos(a) * 22, p.y + Math.sin(a) * 22);
          const life = await frame.spawn({ type: 'replicator', x: pos.x, y: pos.y, from: p, energy: 40, stability: 55, parent: p.id, why: 'emergence' });
          await q('INSERT INTO relationships (object_a, object_b, relationship_type, created_tick) VALUES ($1, $2, $3, $4)', [p.id, life.id, 'bond', frame.tick]);
          p.props = { ...p.props, life: true };
          const [first] = await q(`SELECT 1 AS x FROM events WHERE event_type = 'LIFE' LIMIT 1`);
          await frame.event('LIFE', first ? `🧬 A self-replicating system emerged on ${labelOf(p)}.` : `🧬 First self-replicating system detected, on ${labelOf(p)}. Nobody placed it there.`,
            { objectId: life.id, regionId: p.region_id, impact: 'cosmic', data: { planet: p.id, observers: Number(w.n) } });
        }
      }
    }
    frame.touch(p);
  }

  // LAW_REPLICATION: living systems feed, grow, copy themselves and sometimes become something more.
  const lifeTypes = Object.keys(TYPES).filter((t) => TYPES[t].life).map((t) => `'${t}'`).join(',');
  for (const o of frame.adopt(await q(`SELECT * FROM objects WHERE type IN (${lifeTypes}) AND state <> 'merged' ORDER BY last_sim_tick ASC LIMIT ${REP.maxPerEpoch} FOR UPDATE`))) {
    if (await frame.settle(o)) continue;
    const hosts = await q(
      `SELECT p.id FROM relationships r JOIN objects p ON p.id IN (r.object_a, r.object_b) AND p.id <> $1
        WHERE (r.object_a = $1 OR r.object_b = $1) AND r.ended_tick IS NULL AND p.energy > 50 AND p.type <> 'remnant' LIMIT 3`, [o.id]);
    for (const h of hosts) { const host = await frame.obj(h.id); if (host) frame.move(host, o, 5 * n, 'sustenance'); }
    if (hosts.length) o.stability = clamp(o.stability + 3, 0, 100);
    o.props = { ...o.props, complexity: complexityOf(o) + 2 * n };
    frame.touch(o);
    const s = sha(`epoch:${epoch}:rep:${o.id}`);
    if (canSplit(o) && o.energy >= REP.energyNeeded && roll(s) < REP.chance) {
      const child = await split(frame, o, s, null);
      for (const h of hosts.slice(0, 1)) await q('INSERT INTO relationships (object_a, object_b, relationship_type, created_tick) VALUES ($1, $2, $3, $4)', [h.id, child.id, 'bond', frame.tick]);
      await frame.event('REPLICATION', `${labelOf(o)} copied itself.`, { objectId: child.id, regionId: o.region_id, impact: 'minor' });
    }
    const to = nextForm(o, false);
    if (to && roll(s, 'evolve') < 0.3) {
      await changeForm(frame, o, to, null, 'No observer caused this directly.');
      if (to === 'intelligence') await frame.event('CIVILIZATION', `🏛️ Civilization detected. ${labelOf(o)} has begun to communicate.`, { objectId: o.id, regionId: o.region_id, impact: 'cosmic' });
    }
  }
  if (extra) await extra(frame, epoch, n);
  await frame.flush();
}

// Where a region's contents come from when it is first given a state.
export async function generateRegion(frame: Frame, gx: number, gy: number, outcome: string, seed: string, userId: number) {
  const id = `${gx}:${gy}`;
  const [r] = await frame.q('INSERT INTO regions (id, gx, gy, entropy, created_tick, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [id, gx, gy, round(LAW_ENTROPY.baseline + roll(seed, 'entropy') * 15), frame.tick, userId]);
  frame.regions.set(id, r);
  let k = 0;
  const rnd = () => roll(seed, 'g' + k++);
  const pos = () => ({ x: (gx + 0.1 + rnd() * 0.8) * REGION_SIZE, y: (gy + 0.1 + rnd() * 0.8) * REGION_SIZE });
  const particle = () => frame.spawn({ type: 'particle', ...pos(), from: frame.vac, energy: 3 + Math.floor(rnd() * 10), stability: 35 + rnd() * 55, props: { found_by: userId }, why: 'given a state' });
  const made: O[] = [];
  const many = async (n: number) => { for (let i = 0; i < n; i++) made.push(await particle()); };
  if (outcome === 'sparse') await many(1 + Math.floor(rnd() * 2));
  else if (outcome === 'scatter') await many(3 + Math.floor(rnd() * 3));
  else if (outcome === 'dust') {
    made.push(await frame.spawn({ type: 'dust', ...pos(), from: frame.vac, energy: 60 + Math.floor(rnd() * 80), stability: 40 + rnd() * 30, props: { found_by: userId }, why: 'given a state' }));
    await many(1 + Math.floor(rnd() * 2));
  } else if (outcome === 'structure') {
    const s = rnd();
    const type = s < 0.55 ? 'core' : s < 0.9 ? 'field' : 'star';
    const energy = type === 'core' ? 200 + Math.floor(rnd() * 300) : type === 'field' ? 40 + Math.floor(rnd() * 50) : 1500 + Math.floor(rnd() * 1000);
    made.push(await frame.spawn({ type, ...pos(), from: frame.vac, energy, stability: 60 + rnd() * 30, props: { found_by: userId }, why: 'given a state' }));
    await many(1 + Math.floor(rnd() * 2));
  } else if (outcome === 'anomaly') {
    made.push(await frame.spawn({ type: 'anomaly', ...pos(), from: frame.vac, energy: 10 + Math.floor(rnd() * 20), stability: 30 + rnd() * 30, props: { found_by: userId }, why: 'given a state' }));
    await many(1);
  }
  return { region: r, made };
}
export { regionOf };
