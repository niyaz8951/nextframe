// THE UNIVERSE ON ITS OWN
// Everything here happens with no observer acting: matter falls together, dust
// condenses, stars ignite on a slowing schedule, stars die and enrich what follows.
// Observers do not cause these things. They can only hurry or disturb them.
import { LAW_EMERGENCE as EM, LAW_GRAVITY as G, REGION_SIZE, starsDue } from './laws.js';
import { roll, sha } from './rng.js';
import type { Obj } from './simulate.js';
import { Frame, clamp, complexityOf, labelOf, round, type Holder } from './world.js';
import { changeForm, checkThresholds, inRegion, maybeEpoch, supernova } from './emergence.js';
import { universeSignals } from '../social.js';

type O = Obj & Holder;

// One step of everything that moves by itself. Called on every frame and every heartbeat.
export async function advance(frame: Frame) {
  await naturalStars(frame);
  await maybeEpoch(frame, cosmicEpoch);
}

// ---- stars that gather themselves --------------------------------------------------
export async function naturalStars(frame: Frame) {
  const age = (Date.now() - new Date(frame.u.big_bang_at).getTime()) / 1000;
  const due = Math.min(starsDue(age) - Number(frame.u.natural_stars), G.maxStarsPerFrame);
  for (let i = 0; i < due; i++) {
    const index = Number(frame.u.natural_stars) + 1;
    if (!(await igniteNaturally(frame, index))) break;   // nowhere left to form one for now
    frame.u.natural_stars = index;
    await frame.flush();   // so the next search sees this star
  }
}

async function igniteNaturally(frame: Frame, index: number) {
  const q = frame.q;
  const s = sha(`natural-star:${index}`);
  // The most advanced gathering of matter, in the region with the fewest stars.
  const [best] = await q(
    `SELECT o.* FROM objects o
       JOIN (SELECT r.id, (SELECT COUNT(*) FROM objects st WHERE st.region_id = r.id AND st.type = 'star') AS stars FROM regions r) rc ON rc.id = o.region_id
      WHERE o.state <> 'merged' AND o.type IN ('core', 'dust') AND rc.stars < $1
      ORDER BY rc.stars ASC, (o.type = 'core') DESC, o.energy DESC, o.id ASC LIMIT 1`, [G.naturalStarsPerRegion]);
  let o: O | null = best ? await frame.obj(Number(best.id)) : null;
  if (!o) {   // no dust anywhere suitable: the vacuum itself condenses
    const [reg] = await q(
      `SELECT r.id, r.gx, r.gy FROM regions r WHERE (SELECT COUNT(*) FROM objects st WHERE st.region_id = r.id AND st.type = 'star') < $1
        ORDER BY (SELECT COUNT(*) FROM objects st WHERE st.region_id = r.id AND st.type = 'star'), r.num LIMIT 1`, [G.naturalStarsPerRegion]);
    if (!reg) return false;
    o = await frame.spawn({ type: 'dust', x: (reg.gx + 0.2 + roll(s, 'x') * 0.6) * REGION_SIZE, y: (reg.gy + 0.2 + roll(s, 'y') * 0.6) * REGION_SIZE, from: frame.vac, energy: 120, stability: 60, why: 'condensation' });
  }
  await frame.settle(o);
  if (o.type !== 'core' && o.type !== 'dust') return true;   // it decayed as we reached it; this slot is spent
  const target = G.starEnergy[0] + Math.floor(roll(s, 'energy') * (G.starEnergy[1] - G.starEnergy[0]));
  frame.move(frame.vac, o, Math.max(0, target - o.energy), 'gravity');
  if (o.type === 'dust') await changeForm(frame, o, 'core', null, '', true);
  o.stability = clamp(o.stability + 20, 60, 100);
  o.last_interaction_tick = frame.tick;
  frame.touch(o);
  await checkThresholds(frame, o, null);
  return true;
}

// ---- once per epoch ---------------------------------------------------------------
async function cosmicEpoch(frame: Frame, epoch: number, n: number) {
  const q = frame.q;
  // Old stars: bring the longest-unattended ones up to date. The spent ones die.
  for (const st of frame.adopt(await q(`SELECT * FROM objects WHERE type = 'star' ORDER BY last_sim_tick ASC LIMIT 30 FOR UPDATE`))) {
    await frame.settle(st);
    if (st.type === 'star' && st.energy <= EM.starDeath) await supernova(frame, st, null);
  }
  // Gravity: a rotating share of regions each epoch.
  const regions = await q('SELECT id, num, gx, gy FROM regions ORDER BY (num * 7919 + $1 * 104729) % 1000003 LIMIT $2', [epoch, G.regionsPerEpoch]);
  for (const r of regions) for (let pass = 0; pass < Math.min(n, 3); pass++) await gravity(frame, r, epoch, pass, n);
  await universeSignals(q, frame.tick, epoch, regions.map((r) => r.id));
}

const LIGHT = new Set(['particle', 'cluster']);

async function gravity(frame: Frame, r: any, epoch: number, pass: number, n: number) {
  const q = frame.q;
  const s = sha(`gravity:${epoch}:${pass}:${r.id}`);
  // Old remnants fade from view. A dead star's remnant stays as a landmark.
  await q(`UPDATE objects SET state = 'merged', props = props || '{"faded": true}'::jsonb
            WHERE region_id = $1 AND type = 'remnant' AND state <> 'merged' AND COALESCE(props->>'was', '') NOT IN ('star', 'singularity', 'intelligence') AND COALESCE((props->>'ended_tick')::bigint, last_interaction_tick) < $2`, [r.id, frame.tick - G.remnantFadeTicks]);
  const all = frame.adopt(await q(`SELECT * FROM objects WHERE region_id = $1 AND state <> 'merged' AND type <> 'remnant' ORDER BY id LIMIT 80 FOR UPDATE`, [r.id]))
    .filter((o) => o.state !== 'merged' && o.type !== 'remnant');
  const light = all.filter((o) => LIGHT.has(o.type));

  // A quiet region occasionally gains a particle from the vacuum.
  if (light.length < 3 && all.length < G.crowdedRegion && roll(s, 'fluct') < G.fluctuationChance) {
    await frame.spawn({ type: 'particle', x: (r.gx + 0.1 + roll(s, 'fx') * 0.8) * REGION_SIZE, y: (r.gy + 0.1 + roll(s, 'fy') * 0.8) * REGION_SIZE, from: frame.vac, energy: 3 + Math.floor(roll(s, 'fe') * 9), stability: 40 + roll(s, 'fs') * 40, why: 'vacuum fluctuation' });
  }
  if (!all.length) return;

  // Light things fall toward the heaviest thing nearby.
  const heavy = all.reduce((a, b) => (b.energy > a.energy ? b : a));
  for (const o of light) {
    const d = Math.hypot(heavy.x - o.x, heavy.y - o.y);
    if (o === heavy || d < 24) continue;
    Object.assign(o, inRegion(o.region_id, o.x + (heavy.x - o.x) * G.drift, o.y + (heavy.y - o.y) * G.drift));
    frame.touch(o);
  }

  // The closest pair of simple things may merge.
  let pair: [O, O] | null = null, best = G.mergeWithin;
  for (let i = 0; i < light.length; i++) for (let j = i + 1; j < light.length; j++) {
    const d = Math.hypot(light[i].x - light[j].x, light[i].y - light[j].y);
    if (d < best) { best = d; pair = [light[i], light[j]]; }
  }
  if (pair && roll(s, 'merge') < G.mergeChance) await absorb(frame, pair[0].energy >= pair[1].energy ? pair[0] : pair[1], pair[0].energy >= pair[1].energy ? pair[1] : pair[0]);

  for (const o of all) {
    if (o.state === 'merged') continue;
    if (o.type === 'cluster' && complexityOf(o) >= G.clusterToDustComplexity) {
      frame.move(frame.vac, o, Math.max(0, 40 - o.energy), 'gravity');
      await changeForm(frame, o, 'dust', null, 'It gathered enough to become a cloud.');
    } else if (o.type === 'dust') {
      // Dust sweeps up nearby particles and thickens.
      for (const p of light) if (p.state !== 'merged' && p.type === 'particle' && Math.hypot(p.x - o.x, p.y - o.y) < 30) await absorb(frame, o, p);
      if (o.energy < G.dustCap) frame.move(frame.vac, o, G.dustAccretion * n, 'gravity');
      if (o.energy >= EM.forms.dustToCore && !o.props?.enriched && all.filter((x) => x.type === 'core').length < G.maxCoresPerRegion && roll(s, 'core' + o.id) < G.dustToCoreChance) await changeForm(frame, o, 'core', null, 'It collapsed under its own weight.');
    } else if (o.type === 'core' && o.energy < G.coreCap) {
      frame.move(frame.vac, o, Math.min(G.coreAccretion * n, G.coreCap - o.energy), 'gravity');
    }
  }

  // A star captures enriched dust that drifts close enough.
  for (const st of all.filter((o) => o.type === 'star')) {
    for (const d of all.filter((o) => (o.type === 'dust' || o.type === 'cluster') && o.props?.enriched && !o.props?.captured && Math.hypot(o.x - st.x, o.y - st.y) < G.captureWithin)) {
      if (roll(s, 'capture' + d.id) >= G.captureChance) continue;
      await q('INSERT INTO relationships (object_a, object_b, relationship_type, strength, created_tick) VALUES ($1, $2, $3, 1, $4)', [st.id, d.id, 'bond', frame.tick]);
      d.props = { ...d.props, captured: st.id }; frame.touch(d);
      await frame.event('CAPTURE', `${labelOf(st)} captured a cloud of enriched dust.`, { objectId: d.id, regionId: r.id });
    }
  }
}

// B becomes part of A. B's row remains as history.
async function absorb(frame: Frame, A: O, B: O) {
  frame.move(B, A, B.energy, 'merge');
  A.props = { ...A.props, complexity: complexityOf(A) + complexityOf(B), merged: [...(A.props.merged || []), B.id].slice(-50) };
  A.information += B.information;
  if (A.type === 'particle') A.type = 'cluster';
  A.stability = round(clamp((A.stability + B.stability) / 2 + 3, 0, 100));
  B.state = 'merged'; B.props = { ...B.props, merged_into: A.id, ended_tick: frame.tick };
  frame.touch(A); frame.touch(B);
  await frame.q('UPDATE relationships SET ended_tick = $2 WHERE (object_a = $1 OR object_b = $1) AND ended_tick IS NULL', [B.id, frame.tick]);
}
