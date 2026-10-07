import { ACTIONS, MODIFIERS, eligibility, type Ctx } from './laws.js';

export interface Outcome { outcome: string; probability: number }
export interface Distribution { outcomes: Outcome[]; modifiers: string[] }

// State + interaction -> the possibilities and how likely each one is.
export function calculateOutcomes(ctx: Ctx): Distribution {
  const action = ACTIONS[ctx.action];
  const w: Record<string, number> = { ...action.base };
  const modifiers: string[] = [];
  for (const m of MODIFIERS) {
    if (!m.when(ctx)) continue;
    let touched = false;
    for (const [k, f] of Object.entries(m.mult(ctx))) {
      if (k in w && w[k] > 0 && f !== 1) { w[k] *= f; touched = true; }
    }
    if (touched) modifiers.push(m.label);
  }
  for (const [k, v] of Object.entries(eligibility(ctx))) if (k in w) w[k] = v;
  return { outcomes: normalize(w), modifiers };
}

// Probabilities are always finite, non-negative and sum to exactly 1.
export function normalize(w: Record<string, number>): Outcome[] {
  let entries = Object.entries(w).map(([k, v]) => [k, Number.isFinite(v) && v > 0 ? v : 0] as [string, number]).filter(([, v]) => v > 0);
  if (!entries.length) entries = [[Object.keys(w)[0], 1]];
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const out = entries.map(([outcome, v]) => ({ outcome, probability: v / total }));
  out.sort((a, b) => b.probability - a.probability);
  const rest = out.slice(1).reduce((s, o) => s + o.probability, 0);
  out[0].probability = 1 - rest;
  return out;
}

export function select(outcomes: Outcome[], r: number): string {
  let acc = 0;
  for (const o of outcomes) { acc += o.probability; if (r < acc) return o.outcome; }
  return outcomes[outcomes.length - 1].outcome;
}
