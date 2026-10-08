// GENESIS: the big bang. Runs exactly once, when the universe table is empty.
// It never runs again. At the first frame there are no stars, no planets and no
// life: only dust, particles and a few fields of energy. Everything else has to
// happen. Genesis is derived from fixed seeds, so it is reproducible.
import { openDb, type DB } from '../db.js';
import { LAW_ENERGY_CONSERVATION as EC, REGION_SIZE as R } from './laws.js';
import { roll, sha } from './rng.js';
import { Frame } from './world.js';

const PRIMORDIAL_RADIUS = 3;   // the first 25 regions exist from the start; everything beyond has no state yet

export async function genesis(db: DB) {
  return db.tx(async (q) => {
    if ((await q('SELECT 1 AS x FROM universe WHERE id = 1')).length) return false;
    await q('INSERT INTO universe (id, current_tick, entropy, total_energy, free_energy, total_information, age, last_epoch) VALUES (1, 0, 1, $1, $1, 0, 0, 0)', [EC.totalEnergy]);
    const f = await Frame.open(q, false);
    f.t0 = f.tick = 0;
    let k = 0;
    const rnd = () => roll(sha('big-bang:' + k++));
    await f.event('GENESIS', 'The first frame. Before this there is no record. There is only dust.', { impact: 'cosmic' });

    const cells: [number, number][] = [];
    for (let d = 0; d <= PRIMORDIAL_RADIUS; d++) for (let gx = -d; gx <= d; gx++) for (const gy of new Set([d - Math.abs(gx), Math.abs(gx) - d])) cells.push([gx, gy]);
    for (const [gx, gy] of cells) {
      await q('INSERT INTO regions (id, gx, gy, entropy, created_tick) VALUES ($1, $2, $3, $4, 0)', [`${gx}:${gy}`, gx, gy, 4 + Math.floor(rnd() * 10)]);
      const at = () => ({ x: (gx + 0.12 + rnd() * 0.76) * R, y: (gy + 0.12 + rnd() * 0.76) * R });
      const origin = gx === 0 && gy === 0;
      const dust = origin ? 2 : 1 + Math.floor(rnd() * 2);
      for (let i = 0; i < dust; i++) await f.spawn({ type: 'dust', ...at(), from: f.vac, energy: 40 + Math.floor(rnd() * 120), stability: 40 + rnd() * 30, why: 'big bang' });
      const particles = origin ? 7 : 3 + Math.floor(rnd() * 4);
      for (let i = 0; i < particles; i++) await f.spawn({ type: 'particle', ...at(), from: f.vac, energy: 3 + Math.floor(rnd() * 10), stability: (origin && i === 0 ? 14 : 35 + rnd() * 55), why: 'big bang' });
      if (origin || rnd() < 0.3) await f.spawn({ type: 'field', ...at(), from: f.vac, energy: 30 + Math.floor(rnd() * 50), stability: 55 + rnd() * 25, why: 'big bang' });
    }
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
