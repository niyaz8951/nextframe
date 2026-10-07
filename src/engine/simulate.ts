// Lazy simulation. Nothing is simulated tick by tick. When something is touched,
// its drift since it was last exact is computed in one step.
import { TYPES, LAW_DECAY } from './laws.js';

export interface Obj {
  id: number; type: string; name: string | null; parent_id: number | null;
  energy: number; stability: number; information: number; state: string;
  created_tick: number; last_interaction_tick: number; last_sim_tick: number;
  owner_user_id: number | null; x: number; y: number; z: number; region_id: string; props: any;
}

export function project(o: Obj, tick: number, regionEntropy: number) {
  const t = TYPES[o.type];
  const dt = Math.max(0, tick - o.last_sim_tick);
  if (!t || o.state === 'merged' || dt === 0) return { stability: o.stability, energy: o.energy, radiated: 0, radTick: o.props.rt ?? o.last_sim_tick, collapsed: false };
  const decay = t.decay * (o.state === 'excited' ? LAW_DECAY.excitedFactor : 1) * (1 + regionEntropy / 100);
  const stability = Math.max(0, o.stability - (decay * dt) / 100);
  let radiated = 0;
  let radTick = o.props.rt ?? o.created_tick;
  if (t.radiate > 0) {
    const due = Math.floor((t.radiate * Math.max(0, tick - radTick)) / 100);
    radiated = Math.min(Math.max(0, o.energy - t.floor), due);
    radTick = due > 0 ? radTick + Math.floor((due * 100) / t.radiate) : radTick;
  }
  return { stability, energy: o.energy - radiated, radiated, radTick, collapsed: t.decay > 0 && stability <= 0 };
}
