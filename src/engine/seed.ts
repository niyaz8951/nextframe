// GENESIS. Runs exactly once, when the universe table is empty. It never runs again:
// there is no reset. Everything is derived from fixed seeds, so genesis is reproducible.
import { openDb, type DB } from '../db.js';
import { LAW_ENERGY_CONSERVATION as EC, REGION_SIZE as R } from './laws.js';
import { roll, sha } from './rng.js';
import { Frame } from './world.js';

export async function genesis(db: DB) {
  return db.tx(async (q) => {
    if ((await q('SELECT 1 AS x FROM universe WHERE id = 1')).length) return false;
    await q('INSERT INTO universe (id, current_tick, entropy, total_energy, free_energy, total_information, age, last_epoch) VALUES (1, 1, 42.8, $1, $1, 0, 1, 8274250)', [EC.totalEnergy]);
    const f = await Frame.open(q, true);
    let k = 0;
    const rnd = () => roll(sha('genesis:' + k++));
    const region = (gx: number, gy: number, entropy: number, tick: number) =>
      q('INSERT INTO regions (id, gx, gy, entropy, created_tick) VALUES ($1, $2, $3, $4, $5)', [`${gx}:${gy}`, gx, gy, entropy, tick]);
    const at = (gx: number, gy: number, fx: number, fy: number) => ({ x: (gx + fx) * R, y: (gy + fy) * R });
    const particles = async (gx: number, gy: number, n: number) => {
      for (let i = 0; i < n; i++) await f.spawn({ type: 'particle', ...at(gx, gy, 0.1 + rnd() * 0.8, 0.1 + rnd() * 0.8), from: f.vac, energy: 3 + Math.floor(rnd() * 10), stability: 40 + rnd() * 50, why: 'genesis' });
    };

    f.tick = 1;
    await f.event('GENESIS', 'The first frame. Before this there is no record.', { impact: 'cosmic' });
    await region(0, 0, 18, 1); await region(1, 0, 12, 1); await region(0, 1, 31, 1); await region(-1, 0, 14, 1);

    // An old star and what gathered around it, long before any observer.
    f.tick = 2_104_553;
    const star = await f.spawn({ type: 'star', ...at(1, 0, 0.55, 0.45), from: f.vac, energy: 2400, stability: 92, props: { origin: 'It ignited before anyone was there to see it.', rt: 8_274_380 }, why: 'genesis' });
    await f.event('FIRST', '⭐ The first Star in this universe has emerged.', { objectId: star.id, regionId: '1:0', impact: 'cosmic', data: { kind: 'star' } });
    await f.event('STAR_IGNITION', '⭐ A star ignited. No observer was present.', { objectId: star.id, regionId: '1:0', impact: 'cosmic' });
    f.tick = 5_310_008;
    const planet = await f.spawn({ type: 'planet', ...at(1, 0, 0.78, 0.62), from: f.vac, energy: 180, stability: 71, props: { complexity: 24 }, why: 'genesis' });
    await q('INSERT INTO relationships (object_a, object_b, relationship_type, strength, created_tick) VALUES ($1, $2, $3, 3, $4)', [star.id, planet.id, 'bond', f.tick]);
    await f.event('FIRST', '🪐 The first Planet in this universe has emerged.', { objectId: planet.id, regionId: '1:0', impact: 'cosmic', data: { kind: 'planet' } });
    await f.spawn({ type: 'cluster', ...at(1, 0, 0.3, 0.3), from: f.vac, energy: 120, stability: 58, props: { complexity: 3 }, why: 'genesis' });
    await particles(1, 0, 3);

    // The origin: where observers arrive. A dormant core waits here, most of the way to ignition.
    f.tick = 7_900_120;
    await f.spawn({ type: 'core', ...at(0, 0, 0.5, 0.48), from: f.vac, energy: 520, stability: 80, why: 'genesis' });
    await f.spawn({ type: 'dust', ...at(0, 0, 0.22, 0.7), from: f.vac, energy: 90, stability: 52, why: 'genesis' });
    await f.spawn({ type: 'field', ...at(0, 0, 0.8, 0.24), from: f.vac, energy: 45, stability: 60, why: 'genesis' });
    await f.spawn({ type: 'cluster', ...at(0, 0, 0.74, 0.76), from: f.vac, energy: 30, stability: 66, props: { complexity: 2 }, why: 'genesis' });
    await f.spawn({ type: 'particle', ...at(0, 0, 0.3, 0.26), from: f.vac, energy: 8, stability: 14, why: 'genesis' });
    await particles(0, 0, 6);

    f.tick = 8_100_000;
    await f.spawn({ type: 'anomaly', ...at(0, 1, 0.6, 0.55), from: f.vac, energy: 22, stability: 95, why: 'genesis' });
    await f.spawn({ type: 'dust', ...at(0, 1, 0.3, 0.35), from: f.vac, energy: 210, stability: 47, why: 'genesis' });
    await particles(0, 1, 3);
    await f.event('ANOMALY', '◇ An anomaly opened. Nothing interacted with anything.', { regionId: '0:1', impact: 'major' });
    await f.spawn({ type: 'field', ...at(-1, 0, 0.4, 0.6), from: f.vac, energy: 70, stability: 64, why: 'genesis' });
    await particles(-1, 0, 4);

    // Everything above is exact as of the moment observers can first arrive.
    f.tick = f.t0 = 8_274_380;
    await q('UPDATE objects SET last_sim_tick = $1, last_interaction_tick = created_tick', [f.tick]);
    for (const o of f.objs.values()) { o.last_sim_tick = f.tick; o.last_interaction_tick = o.created_tick; }
    await f.flush();
    return true;
  });
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  openDb().then(async (db) => {
    console.log((await genesis(db)) ? '[genesis] the universe has begun' : '[genesis] the universe already exists - it is never reset');
    await db.close();
  });
}
