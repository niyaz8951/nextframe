import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import type { DB } from './db.js';
import { LAW_ENERGY_CONSERVATION as EC, REGION_SIZE } from './engine/laws.js';
import { Frame, GameError } from './engine/world.js';

const ORIGIN_CAPACITY = 40;   // after this many arrivals at one region, newcomers arrive elsewhere
const sign = (id: number) => jwt.sign({ sub: String(id) }, config.jwtSecret, { expiresIn: '30d' });

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', config.jwtSecret) as any;
    (req as any).userId = Number(p.sub);
    if (!Number.isInteger((req as any).userId)) throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'You are not signed in.' });
  }
}

export async function register(db: DB, body: any) {
  const username = String(body?.username || '').trim();
  const email = String(body?.email || '').trim().toLowerCase();
  const password = String(body?.password || '');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new GameError(400, 'Username: 3-20 letters, numbers or underscores.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new GameError(400, 'Please enter a valid email address.');
  if (password.length < 8 || password.length > 200) throw new GameError(400, 'Password: at least 8 characters.');
  const hash = await bcrypt.hash(password, 11);

  const user = await db.tx(async (q) => {
    const f = await Frame.open(q, true);
    if ((await q('SELECT 1 AS x FROM users WHERE lower(username) = lower($1) OR lower(email) = $2', [username, email])).length) throw new GameError(409, 'That username or email is already part of this universe.');
    // Everyone arrives at the origin until it is crowded; then at the quietest known region.
    const [origin] = await q(`SELECT r.id, (SELECT COUNT(*) FROM users u WHERE u.current_location = r.id) AS n FROM regions r WHERE r.id = '0:0'`);
    let start = origin.id;
    if (Number(origin.n) >= ORIGIN_CAPACITY) {
      const [quiet] = await q(`SELECT r.id FROM regions r WHERE EXISTS (SELECT 1 FROM objects o WHERE o.region_id = r.id)
                               ORDER BY (SELECT COUNT(*) FROM user_regions ur WHERE ur.region_id = r.id), abs(r.gx) + abs(r.gy), r.id LIMIT 1`);
      if (quiet) start = quiet.id;
    }
    f.tick = f.t0 + 1;
    const [u] = await q(
      `INSERT INTO users (username, email, password_hash, last_seen_tick, energy, current_location, life_started_tick, stats)
       VALUES ($1, $2, $3, $4, 0, $5, $4, '{"total":0}'::jsonb) RETURNING *`, [username, email, hash, f.tick, start]);
    const holder = { energy: 0, key: `observer:${u.id}` };
    f.move(f.vac, holder, EC.observerStart, 'arrival');
    const [gx, gy] = start.split(':').map(Number);
    const [first] = await q(`SELECT id FROM objects WHERE region_id = $1 AND type = 'particle' AND state <> 'merged' ORDER BY (x-$2)*(x-$2)+(y-$3)*(y-$3) LIMIT 1`, [start, (gx + 0.5) * REGION_SIZE, (gy + 0.5) * REGION_SIZE]);
    await q(`UPDATE users SET energy = $2, stats = $3::jsonb WHERE id = $1`, [u.id, holder.energy, JSON.stringify({ total: 0, actions: {}, outcomes: {}, first_object: first?.id ?? null })]);
    await q('INSERT INTO user_regions (user_id, region_id, discovered_tick) VALUES ($1, $2, $3)', [u.id, start, f.tick]);
    await f.event('ARRIVAL', `A new observer arrived: ${username}.`, { userId: u.id, regionId: start });
    await f.flush();
    return { id: Number(u.id), username, arrivedTick: f.tick };
  });
  console.log(`[audit] register user=${user.id}`);
  return { token: sign(user.id), ...user, firstArrival: true };
}

export async function login(db: DB, body: any) {
  const id = String(body?.login || body?.email || body?.username || '').trim().toLowerCase();
  const password = String(body?.password || '');
  const [u] = await db.q('SELECT id, username, password_hash FROM users WHERE lower(email) = $1 OR lower(username) = $1', [id]);
  // Compare against a dummy hash when the user is unknown, so timing reveals nothing.
  const ok = await bcrypt.compare(password, u?.password_hash || '$2b$11$CwTycUXWue0Thq9StjUM0uJ8rYVxFv0sTqe0Fz1mYF8rW2iGmuy0e');
  if (!u || !ok) { console.log('[audit] failed login'); throw new GameError(401, 'Those details do not match any observer.'); }
  console.log(`[audit] login user=${u.id}`);
  return { token: sign(Number(u.id)), id: Number(u.id), username: u.username };
}
