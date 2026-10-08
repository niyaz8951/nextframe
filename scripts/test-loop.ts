// End-to-end check of the engine: the full loop, conservation of energy,
// valid probabilities, reproducible outcomes and immutable history.
// Runs on a throwaway in-memory universe unless DATABASE_URL is set.
process.env.DATA_DIR ||= 'memory://';
process.env.JWT_SECRET ||= 'test-secret';
process.env.HEARTBEAT_SECONDS = '0';   // the test drives time itself
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
const stars0 = await db.q(`SELECT COUNT(*) AS n FROM objects WHERE type IN ('star', 'planet', 'core')`);
check(Number(stars0[0].n) === 0, 'the universe begins with dust only: no stars, planets or cores');

// --- the universe on its own: ten minutes after the big bang, about ten stars have formed unaided ---
await db.q(`UPDATE universe SET big_bang_at = now() - interval '10 minutes'`);
await heartbeat(db);
const [nat] = await db.q(`SELECT natural_stars, era, (SELECT COUNT(*) FROM objects WHERE type = 'star') AS stars FROM universe`);
check(Number(nat.natural_stars) >= 9 && Number(nat.stars) >= 9, 'stars ignite by themselves on the schedule (one a minute at first)', `${nat.stars} stars after 10 minutes, era ${nat.era}`);
check(Number(nat.era) === 1, 'the first star began a new era');
check(await conserved(), 'energy is conserved after natural star formation');

// For the collective test, let one cloud at the origin have collapsed into a dormant core (test-only shortcut).
await db.q(`UPDATE objects SET type = 'core', state = 'dormant', stability = 80 WHERE id = (SELECT id FROM objects WHERE region_id = '0:0' AND type = 'dust' ORDER BY energy DESC LIMIT 1)`);
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
for (let i = 0; i < 90 && !ignited; i++) {
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
for (let i = 0; i < 12; i++) await heartbeat(db, 260);
check(await conserved(), 'energy is conserved after twelve background epochs of gravity');
const [grav] = await db.q(`SELECT (SELECT COUNT(*) FROM objects WHERE props ? 'merged') AS merged, (SELECT COUNT(*) FROM events WHERE event_type = 'TRANSFORMATION' AND created_by_user_id IS NULL) AS natural`);
check(Number(grav.merged) > 0, 'matter gathers by itself between epochs', `${grav.merged} objects have absorbed others; ${grav.natural} unaided transformations`);

// --- stellar death: drain a star to its last energy; the next epoch it dies and enriches its surroundings ---
await db.q(`WITH s AS (SELECT id, energy - 41 AS e FROM objects WHERE type = 'star' ORDER BY id LIMIT 1), a AS (UPDATE objects o SET energy = 41 FROM s WHERE o.id = s.id) UPDATE universe SET free_energy = free_energy + (SELECT e FROM s)`);
for (let i = 0; i < 3; i++) await heartbeat(db, 260);
const [nova] = await db.q(`SELECT (SELECT COUNT(*) FROM events WHERE event_type = 'SUPERNOVA') AS n, (SELECT COUNT(*) FROM objects WHERE props ? 'enriched') AS dust, era FROM universe`);
check(Number(nova.n) >= 1 && Number(nova.dust) >= 2 && Number(nova.era) >= 2, 'a spent star dies and scatters enriched dust', `${nova.n} supernova, ${nova.dust} enriched clouds, era ${nova.era}`);
check(await conserved(), 'energy is conserved after a supernova');

// --- practice: each gesture has its own mastery, earned only by use ---------------
{
  const { publicUser } = await import('../src/engine/interact.js');
  const [row] = await db.q('SELECT * FROM users WHERE id = $1', [A.id]);
  const pu = publicUser(row);
  const top = pu.gestures.slice().sort((x: any, y: any) => y.uses - x.uses)[0];
  check(pu.gestures.length >= 8 && top.level >= 1 && pu.rank !== 'Unknown Observer', 'gestures are discovered by use and mastery grows with practice', `${pu.gestures.length} found; most practised: ${top.name} ×${top.uses} (level ${top.level}); title: ${pu.rank}`);
  const [m] = await db.q(`SELECT COUNT(*) AS n FROM interactions WHERE (probability_data->'ctx'->>'mastery')::int > 0 AND probability_data->'modifiers' ? 'Your practice with this gesture'`);
  check(Number(m.n) > 0, 'practice bends the odds of the gesture practised', `${m.n} interactions were shaped by mastery`);
}

// --- finding each other: signal -> echo -> answer --------------------------------
{
  const express = (await import('express')).default;
  const { api } = await import('../src/routes.js');
  const jwt = (await import('jsonwebtoken')).default;
  const app = express(); app.use(express.json()); app.use('/api', api(db));
  const srv = app.listen(0); const base = `http://127.0.0.1:${(srv.address() as any).port}/api`;
  const call = async (u: any, path: string, body?: any) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + jwt.sign({ sub: String(u.id) }, process.env.JWT_SECRET!) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, ...(await r.json() as any) };
  };
  await give(A.id, 60); await give(B.id, 60); await give(C.id, 60);
  const target = (await db.q(`SELECT o.id FROM objects o WHERE o.region_id = '0:0' AND o.state <> 'merged' AND o.type <> 'remnant' ORDER BY o.id DESC LIMIT 1`))[0].id;
  for (const u of users) await db.q('INSERT INTO observations (user_id, object_id, level, count, first_tick) VALUES ($1, $2, 1, 1, 0) ON CONFLICT DO NOTHING', [u.id, target]);
  const tl = await call(B, '/timeline');
  check(tl.interactions.every((i: any) => i.mine || i.observer === 'An observer'), 'before contact, other observers have no names anywhere in the record');
  const s1 = await call(A, `/objects/${target}/signal`, { pattern: '204' });
  const seenByB = (await call(B, `/objects/${target}`)).signals;
  check(s1.ok && seenByB.some((x: any) => x.id === s1.id && !x.mine && x.canEcho) && !('user_id' in seenByB[0]), 'a signal is visible on the object with no author');
  const e1 = await call(B, `/signals/${s1.id}/echo`, {});
  check(e1.ok && e1.contact === null, 'echoing a signal does not reveal who left it');
  const mineA = (await call(A, '/signals')).signals.find((x: any) => x.id === s1.id);
  check(mineA.openEcho === e1.id, 'the sender sees that something echoed, not who');
  const denied = await call(A, `/contacts/1/messages`, { body: 'hello?' });
  check(denied.status === 404, 'no speech before contact');
  const a1 = await call(A, `/signals/${e1.id}/echo`, {});
  check(a1.contact?.username === B.username, 'answering an observer\'s echo makes contact and reveals the name', a1.narrative);
  await call(A, `/contacts/${a1.contact.id}/messages`, { body: 'Is anyone there?' });
  const got = await call(B, `/contacts/${a1.contact.id}/messages`);
  check(got.messages.length === 1 && got.messages[0].body === 'Is anyone there?' && !got.messages[0].mine, 'after contact they can speak');
  check((await call(C, `/contacts/${a1.contact.id}/messages`)).status === 404, 'a third observer cannot read their channel');
  // the universe echoes too, and answering it leads nowhere
  const s2 = await call(C, `/objects/${target}/signal`, { pattern: '111' });
  await db.q('INSERT INTO signals (object_id, user_id, pattern, reply_to, universe_tick) VALUES ($1, NULL, $2, $3, 0)', [target, '111', s2.id]);
  const uEcho = (await call(C, '/signals')).signals.find((x: any) => x.id === s2.id).openEcho;
  const a2 = await call(C, `/signals/${uEcho}/echo`, {});
  check(a2.ok && a2.contact === null && a2.narrative === e1.narrative, 'answering the universe\'s echo looks the same and reveals nothing');
  check(await conserved(), 'energy is conserved after signalling');
  srv.close();
}

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
