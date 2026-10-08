// A Frame is one step of the universe: it locks the present, lets the engine
// change it, and writes the next state. Everything inside one Frame is atomic.
import type { Q } from '../db.js';
import { config } from '../config.js';
import { ERAS, LAW_ENERGY_CONSERVATION as EC, LAW_ENTROPY, REGION_SIZE, TYPES } from './laws.js';
import { project, type Obj } from './simulate.js';

export class GameError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export interface Holder { energy: number; key: string }

export const regionId = (gx: number, gy: number) => `${gx}:${gy}`;
export const regionOf = (x: number, y: number) => ({ gx: Math.floor(x / REGION_SIZE), gy: Math.floor(y / REGION_SIZE) });
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
export const complexityOf = (o: Obj) => Number(o.props?.complexity ?? 1);
export const labelOf = (o: Obj) => o.name || `${TYPES[o.type]?.label ?? 'Object'} #${o.id}`;
const BASE_COMPLEXITY: Record<string, number> = { particle: 1, cluster: 2, field: 2, dust: 5, core: 15, planet: 20, star: 40, replicator: 40, organism: 80, ecosystem: 150, intelligence: 300, singularity: 500, anomaly: 9, remnant: 1 };
export const baseComplexity = (type: string) => BASE_COMPLEXITY[type] ?? 1;

export class Frame {
  u: any;
  t0 = 0;           // the tick whose state we are reading
  tick = 0;         // the tick being written
  vac: Holder = { energy: 0, key: 'vacuum' };
  objs = new Map<number, Obj & Holder>();
  dirty = new Set<number>();
  regions = new Map<string, any>();
  dirtyRegions = new Set<string>();
  transfers: { from: string; to: string; amount: number; why: string }[] = [];
  events: any[] = [];
  spawned: (Obj & Holder)[] = [];
  dissipated = 0;
  info = 0;

  private constructor(public q: Q, public lock: boolean) {}

  static async open(q: Q, lock = true) {
    const f = new Frame(q, lock);
    const [u] = await q(`SELECT * FROM universe WHERE id = 1 ${lock ? 'FOR UPDATE' : ''}`);
    if (!u) throw new GameError(503, 'The universe has not begun yet.');
    f.u = u; f.t0 = f.tick = u.current_tick; f.vac.energy = u.free_energy;
    // The clock is tied to real time: whatever time has passed since the last frame (even while
    // the server slept) is added now, so the universe ages whether or not anyone is here.
    const rate = config.heartbeatSeconds > 0 ? config.heartbeatTicks / config.heartbeatSeconds : 0;
    if (lock && rate > 0) {
      const at = new Date(u.clock_at).getTime();
      const due = Math.floor(((Date.now() - at) / 1000) * rate);
      if (due > 0) { f.t0 = f.tick = u.current_tick + due; u.clock_at = new Date(at + (due / rate) * 1000); }
    }
    return f;
  }

  async obj(id: number): Promise<(Obj & Holder) | null> {
    if (this.objs.has(id)) return this.objs.get(id)!;
    const [o] = await this.q(`SELECT * FROM objects WHERE id = $1 ${this.lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!o) return null;
    o.key = `object:${o.id}`;
    this.objs.set(o.id, o);
    return o;
  }
  adopt(rows: any[]) {
    return rows.map((o) => {
      if (this.objs.has(o.id)) return this.objs.get(o.id)!;
      o.key = `object:${o.id}`; this.objs.set(o.id, o); return o as Obj & Holder;
    });
  }
  async region(id: string) {
    if (this.regions.has(id)) return this.regions.get(id);
    const [r] = await this.q(`SELECT * FROM regions WHERE id = $1 ${this.lock ? 'FOR UPDATE' : ''}`, [id]);
    if (r) this.regions.set(id, r);
    return r || null;
  }
  touch(o: Obj) { this.dirty.add(o.id); }
  touchRegion(r: any) { this.dirtyRegions.add(r.id); }

  // LAW_ENERGY_CONSERVATION: energy only ever moves. Returns what actually moved.
  move(from: Holder, to: Holder, amount: number, why: string) {
    let n = Math.floor(Math.min(amount, from.energy));
    if (to.key.startsWith('observer:')) n = Math.min(n, Math.max(0, ((to as any).cap ?? EC.observerCap) - to.energy));
    if (n <= 0) return 0;
    from.energy -= n; to.energy += n;
    for (const h of [from, to]) if (h.key.startsWith('object:')) this.dirty.add(Number(h.key.slice(7)));
    if (to === this.vac) this.dissipated += n;
    this.transfers.push({ from: from.key, to: to.key, amount: n, why });
    return n;
  }

  // Bring an object up to the present (lazy simulation).
  async settle(o: Obj & Holder) {
    if (o.last_sim_tick >= this.t0 || o.state === 'merged') return false;
    const r = await this.region(o.region_id);
    const p = project(o, this.t0, r?.entropy ?? LAW_ENTROPY.baseline);
    o.stability = round(p.stability);
    if (p.radiated > 0) this.move(o, this.vac, p.radiated, 'radiated');
    if (TYPES[o.type]?.radiate) o.props = { ...o.props, rt: p.radTick };
    o.last_sim_tick = this.t0;
    this.touch(o);
    if (p.collapsed) { await this.collapse(o, 'It decayed, unobserved.'); return true; }
    return false;
  }

  async collapse(o: Obj & Holder, why: string, userId: number | null = null) {
    const was = o.type;
    const label = labelOf(o);
    this.move(o, this.vac, o.energy, 'collapse');
    o.props = { ...o.props, was, ended_tick: this.tick };
    o.type = 'remnant'; o.state = 'dormant'; o.stability = 0;
    this.touch(o);
    await this.q('UPDATE relationships SET ended_tick = $2 WHERE (object_a = $1 OR object_b = $1) AND ended_tick IS NULL', [o.id, this.tick]);
    const big = TYPES[was]?.massive || TYPES[was]?.life;
    await this.event('COLLAPSE', `${label} collapsed. ${why} A remnant marks where it was.`, { objectId: o.id, regionId: o.region_id, userId, impact: big ? 'major' : 'minor', data: { was } });
  }

  async spawn(p: { type: string; x: number; y: number; from: Holder; energy: number; stability?: number; state?: string; owner?: number | null; parent?: number | null; props?: any; why?: string }) {
    const { gx, gy } = regionOf(p.x, p.y);
    const props = { complexity: baseComplexity(p.type), ...(p.props || {}) };
    const [o] = await this.q(
      `INSERT INTO objects (type, energy, stability, information, state, created_tick, last_interaction_tick, last_sim_tick, owner_user_id, parent_id, x, y, region_id, props)
       VALUES ($1, 0, $2, 1, $3, $4, $4, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING *`,
      [p.type, round(p.stability ?? 50), p.state ?? (p.type === 'core' ? 'dormant' : 'calm'), this.tick, p.owner ?? null, p.parent ?? null, round(p.x, 2), round(p.y, 2), regionId(gx, gy), JSON.stringify(props)]);
    o.key = `object:${o.id}`;
    this.objs.set(o.id, o);
    this.move(p.from, o, p.energy, p.why || 'creation');
    this.info += 1;
    this.spawned.push(o);
    return o as Obj & Holder;
  }

  async event(type: string, description: string, e: { objectId?: number | null; regionId?: string | null; userId?: number | null; impact?: string; data?: any } = {}) {
    const [row] = await this.q(
      `INSERT INTO events (universe_tick, event_type, description, affected_object_id, region_id, created_by_user_id, impact, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id, universe_tick, event_type, description, affected_object_id, region_id, impact`,
      [this.tick, type, description, e.objectId ?? null, e.regionId ?? null, e.userId ?? null, e.impact ?? 'minor', JSON.stringify(e.data ?? {})]);
    this.events.push(row);
    // Eras: the universe is in the latest age whose defining thing has happened at least once.
    const kind = e.data?.kind;
    const era = type === 'CIVILIZATION' || kind === 'intelligence' ? 5 : type === 'LIFE' || kind === 'replicator' ? 4 : kind === 'planet' ? 3
      : type === 'SUPERNOVA' ? 2 : type === 'STAR_IGNITION' || kind === 'star' ? 1 : 0;
    if (era > (this.u.era || 0)) {
      this.u.era = era;
      await this.event('ERA', `A new age has begun: ${ERAS[era]}.`, { impact: 'cosmic', data: { era } });
    }
    return row;
  }

  // Write the next state. Safe to call more than once.
  async flush() {
    for (const id of this.dirty) {
      const o = this.objs.get(id)!;
      await this.q(
        `UPDATE objects SET type=$2, name=$3, energy=$4, stability=$5, information=$6, state=$7, last_interaction_tick=$8,
           last_sim_tick=$9, x=$10, y=$11, region_id=$12, props=$13::jsonb, parent_id=$14 WHERE id=$1`,
        [o.id, o.type, o.name, o.energy, round(clamp(o.stability, 0, 100)), o.information, o.state, o.last_interaction_tick, o.last_sim_tick, o.x, o.y, o.region_id, JSON.stringify(o.props || {}), o.parent_id]);
    }
    for (const id of this.dirtyRegions) {
      const r = this.regions.get(id)!;
      await this.q('UPDATE regions SET entropy=$2, state=$3, converged=$4, interaction_count=$5 WHERE id=$1', [r.id, round(Math.max(0, r.entropy)), r.state, r.converged, r.interaction_count]);
    }
    this.u.entropy = round(this.u.entropy + this.dissipated * LAW_ENTROPY.perDissipated, 5);
    this.u.total_information += this.info;
    this.u.free_energy = this.vac.energy;
    this.u.current_tick = this.u.age = this.tick;
    await this.q('UPDATE universe SET current_tick=$1, age=$1, entropy=$2, free_energy=$3, total_information=$4, last_epoch=$5, clock_at=$6, natural_stars=$7, era=$8 WHERE id=1',
      [this.tick, this.u.entropy, this.u.free_energy, this.u.total_information, this.u.last_epoch, this.u.clock_at, this.u.natural_stars, this.u.era]);
    this.dirty.clear(); this.dirtyRegions.clear(); this.objs.clear(); this.regions.clear();
    this.dissipated = 0; this.info = 0;
  }
}

// Passive recharge: the vacuum slowly refills an observer, up to a low cap.
export function regenDue(user: any, now = Date.now()) {
  const n = Math.floor((now - new Date(user.energy_updated_at).getTime()) / (EC.regenSeconds * 1000));
  return Math.max(0, Math.min(n, EC.regenCap - user.energy));
}
export function applyRegen(frame: Frame, user: any & Holder) {
  const due = regenDue(user);
  if (due > 0) frame.move(frame.vac, user, due, 'vacuum recharge');
  const steps = Math.floor((Date.now() - new Date(user.energy_updated_at).getTime()) / (EC.regenSeconds * 1000));
  if (steps > 0) user.energy_updated_at = new Date(new Date(user.energy_updated_at).getTime() + steps * EC.regenSeconds * 1000);
}
