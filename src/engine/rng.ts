// Deterministic randomness. An outcome is a pure function of the interaction
// and the state it met: the same state and the same act always collapse the same way.
import crypto from 'node:crypto';

export const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// Stable JSON (sorted keys) so that equal states always hash equally.
export function stable(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

export function makeSeed(p: { interactionId: number; stateBefore: any; objectId: number | null; userId: number; tick: number; type: string; input: any }) {
  return sha([p.interactionId, sha(stable(p.stateBefore)), p.objectId ?? 'void', p.userId, p.tick, p.type, stable(p.input)].join('|'));
}

// A number in [0, 1) from a seed. `salt` derives independent sub-rolls.
export function roll(seed: string, salt = ''): number {
  const h = salt ? sha(seed + ':' + salt) : seed;
  return parseInt(h.slice(0, 13), 16) / 2 ** 52;
}
