// End-to-end check of the engine: the full loop, conservation of energy,
// valid probabilities, reproducible outcomes and immutable history.
// Runs on a throwaway in-memory universe unless DATABASE_URL is set.
process.env.DATA_DIR ||= 'memory://';
process.env.JWT_SECRET ||= 'test-secret';
const { openDb } = await import('../src/db.js');
const { genesis } = await import('../src/engine/seed.js');
const { register } = await import('../src/auth.js');
const { interact, possibilities, verify, heartbeat } = await import('../src/engine/interact.js');
const { ACTIONS } = await import('../src/engine/laws.js');
const { roll, sha } = await import('../src/engine/rng.js');

const db = await openDb();
let failed = 0;
const check = (ok: boolean, name: string, extra = '') => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const conserved = async () => {
  const [r] = await db.q(`SELECT (SELECT COALESCE(SUM(energy),0) FROM objects) + (SELECT COALESCE(SUM(energy),0) FROM users) + free_energy AS have, total_energy AS total FROM universe`);
  return Number(r.have) === Number(r.total);
};
const tag = Date.now().toString(36);

await genesis(db);
check(await genesis(db) === false, 'genesis runs once; the universe is never reset');
check(await conserved(), 'energy is conserved after genesis');

const A = await register(db, { username: `ada_${tag}`, email: `ada_${tag}@example.com`, password: 'correct horse' });
const B = await register(db, { username: `bo_${tag}`, email: `bo_${tag}@example.com`, password: 'correct horse' });
const C = await register(db, { username: `cy_${tag}`, email: `cy_${tag}@example.com`, password: 'correct horse' });
check(await conserved(), 'energy is conserved after three observers arrive');
const give = (id: number, n: number) => db.q('WITH a AS (UPDATE users SET energy = energy + $2 WHERE id = $1) UPDATE universe SET free_energy = free_energy - $2', [id, n]); // test-only top-up, taken from the vacuum

// --- the core loop: A changes the world, B sees the consequence -------------------
const objs = async (userId: number) => db.q(`SELECT o.* FROM objects o JOIN user_regions ur ON ur.region_id = o.region_id AND ur.user_id = $1 WHERE o.state <> 'merged' ORDER BY o.id`, [userId]);
const core = (await objs(A.id)).find((o) => o.type === 'core');
const pre = await possibilities(db, { userId: A.id, type: 'observe', objectId: core.id }) as any;
check(pre.outcomes.every((o: any) => o.label === null), 'unwitnessed outcomes are unnamed in the preview');
const first = await interact(db, { userId: A.id, type: 'observe', objectId: core.id }) as any;
check(first.universeTick > 0 && !!first.seed && first.roll >= 0 && first.roll < 1, 'observe returns a tick, a seed and a roll', `tick ${first.universeTick} roll ${first.roll.toFixed(4)} -> ${first.outcome}`);
const made = await interact(db, { userId: A.id, type: 'create', x: 60, y: 60 }) as any;
const bSees = await objs(B.id);
check(made.created.length === 0 || bSees.some((o) => Number(o.id) === made.created[0].id), 'what A creates exists for B', `outcome: ${made.outcome}`);
const [hist] = await db.q('SELECT COUNT(*) AS n FROM interactions WHERE user_id = $1', [A.id]);
check(Number(hist.n) === 2, 'every interaction is recorded');

// --- collective emergence: three observers feed the dormant core until it ignites --
let ignited = false, gifts = 0;
for (let i = 0; i < 60 && !ignited; i++) {
  const who = [A, B, C][i % 3];
  await give(who.id, 40);
  const r = await interact(db, { userId: who.id, type: 'energize', objectId: core.id, amount: 40 }) as any;
  gifts++;
  if (r.decayed) break;
  ignited = r.events.some((e: any) => e.event_type === 'STAR_IGNITION');
}
const [star] = await db.q('SELECT type, energy, props FROM objects WHERE id = $1', [core.id]);
check(ignited && star.type === 'star', 'a dormant core fed by several observers ignites into a star', `after ${gifts} gifts: "${star.props?.origin || ''}"`);
check((await db.q(`SELECT 1 AS x FROM events WHERE event_type = 'COLLECTIVE'`)).length > 0, 'collective energy event was detected');
check((await db.q(`SELECT 1 AS x FROM events WHERE event_type = 'CONVERGENCE'`)).length > 0, 'convergence was detected when three observers met in one region');
check(await conserved(), 'energy is conserved after ignition');

// --- a long random history ---------------------------------------------------------
const users = [A, B, C];
const tally: Record<string, number> = {};
let done = 0, refused = 0;
for (let n = 0; n < 900; n++) {
  const who = users[n % 3];
  const rnd = (s: string) => roll(sha(`t:${n}:${s}`));
  const list = (await objs(who.id)).filter((o) => o.type !== 'remnant' || rnd('rem') < 0.2);
  const types = Object.keys(ACTIONS);
  const type = types[Math.floor(rnd('type') * types.length)];
  const a = ACTIONS[type];
  const o = list[Math.floor(rnd('obj') * list.length)];
  const input: any = { userId: who.id, type, focus: 1 + Math.floor(rnd('focus') * 3) };
  if (a.needs === 'object' || a.needs === 'target') input.objectId = Number(o.id);
  if (a.needs === 'target') input.targetId = Number(list[Math.floor(rnd('tgt') * list.length)].id);
  if (a.amounts) input.amount = a.amounts[Math.floor(rnd('amt') * a.amounts.length)];
  if (a.needs === 'point') { input.x = o.x + (rnd('x') - 0.5) * 60; input.y = o.y + (rnd('y') - 0.5) * 60; }
  if (a.needs === 'region') {
    const regs = await db.q('SELECT r.gx, r.gy FROM user_regions ur JOIN regions r ON r.id = ur.region_id WHERE ur.user_id = $1', [who.id]);
    const g = regs[Math.floor(rnd('reg') * regs.length)];
    const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(rnd('dir') * 4)];
    input.gx = g.gx + d[0]; input.gy = g.gy + d[1];
  }
  await give(who.id, 20);
  try {
    const r = await interact(db, input) as any;
    done++;
    if (!r.decayed) tally[`${type}:${r.outcome}`] = (tally[`${type}:${r.outcome}`] || 0) + 1;
  } catch (e: any) {
    if (e.status && e.status < 500) refused++; else throw e;
  }
  if (n % 150 === 149) check(await conserved(), `energy is conserved after ${n + 1} attempted interactions`);
}
console.log(`       ${done} interactions resolved, ${refused} refused by the laws`);
await heartbeat(db, 600);
check(await conserved(), 'energy is conserved after a background epoch');

// --- the record --------------------------------------------------------------------
const rows = await db.q('SELECT id, probability_data, outcome FROM interactions ORDER BY id');
let badProb = 0, badVerify = 0;
for (const i of rows) {
  const ps = i.probability_data.outcomes.map((o: any) => o.probability);
  if (ps.some((p: number) => !Number.isFinite(p) || p < 0) || Math.abs(ps.reduce((s: number, p: number) => s + p, 0) - 1) > 1e-9) badProb++;
}
for (const i of rows.filter((_, k) => k % 7 === 0)) if (!(await verify(db, Number(i.id), 0)).ok) badVerify++;
check(badProb === 0, `all ${rows.length} recorded distributions are finite, non-negative and sum to 1`);
check(badVerify === 0, 'recorded outcomes re-derive exactly from state + interaction (determinism)');
let blocked = false;
try { await db.q(`UPDATE interactions SET outcome = 'rewritten' WHERE id = $1`, [rows[0].id]); } catch { blocked = true; }
check(blocked, 'history is immutable: the database refuses to rewrite an interaction');
const [u] = await db.q('SELECT current_tick, entropy, free_energy, total_energy FROM universe');
const kinds = await db.q(`SELECT type, COUNT(*) AS n FROM objects WHERE state <> 'merged' GROUP BY type ORDER BY n DESC`);
const ev = await db.q(`SELECT event_type, COUNT(*) AS n FROM events GROUP BY event_type ORDER BY n DESC`);
console.log(`\nuniverse: tick ${u.current_tick}, entropy ${u.entropy}, vacuum ${u.free_energy}/${u.total_energy}`);
console.log('objects :', kinds.map((k) => `${k.type}×${k.n}`).join(' '));
console.log('events  :', ev.map((k) => `${k.event_type}×${k.n}`).join(' '));
console.log('outcomes:', Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join(' '));
console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
await db.close();
process.exit(failed ? 1 : 0);
