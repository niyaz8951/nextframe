// What does the universe do with nobody in it? Fast-forwards an empty universe and
// reports when things first happen. Usage: npx tsx scripts/simulate-alone.ts [days]
// Runs on a throwaway in-memory universe; it never touches a real database.
process.env.DATA_DIR = 'memory://'; process.env.DATABASE_URL = ''; process.env.JWT_SECRET ||= 'sim'; process.env.HEARTBEAT_SECONDS = '0';
const { openDb } = await import('../src/db.js');
const { genesis } = await import('../src/engine/seed.js');
const { heartbeat } = await import('../src/engine/interact.js');
const days = Number(process.argv[2] || 30);
const db = await openDb();
await genesis(db);
const seen = new Set<string>();
const step = async (minutes: number) => { await db.q(`UPDATE universe SET big_bang_at = big_bang_at - ($1 || ' minutes')::interval`, [String(minutes)]); await heartbeat(db, minutes * 5); };
const report = async (label: string) => {
  const ev = await db.q(`SELECT event_type, description FROM events WHERE event_type IN ('ERA','FIRST','LIFE','CIVILIZATION') ORDER BY id`);
  for (const e of ev) if (!seen.has(e.description)) { seen.add(e.description); console.log(`${label.padEnd(9)} ${e.description}`); }
};
for (let m = 0; m < 30; m++) { await step(1); await report(`${m + 1} min`); }
for (let h = 1; h <= days * 24; h++) { await step(60); await report(h < 48 ? `${h} h` : `day ${(h / 24).toFixed(1)}`); }
const kinds = await db.q(`SELECT type, COUNT(*) AS n FROM objects WHERE state <> 'merged' GROUP BY type ORDER BY n DESC`);
const [u] = await db.q(`SELECT current_tick, natural_stars, era, entropy, (SELECT COUNT(*) FROM events WHERE event_type = 'SUPERNOVA') AS novae, (SELECT (SELECT COALESCE(SUM(energy),0) FROM objects) + (SELECT COALESCE(SUM(energy),0) FROM users) + free_energy = total_energy) AS conserved FROM universe`);
console.log(`\nafter ${days} days alone: tick ${u.current_tick}, ${u.natural_stars} stars formed unaided, ${u.novae} supernovae, era ${u.era}, energy conserved: ${u.conserved}`);
console.log(kinds.map((k) => `${k.type}×${k.n}`).join(' '));
await db.close(); process.exit(0);
