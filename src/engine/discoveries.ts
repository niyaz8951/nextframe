// Discoveries are hypotheses an observer earns by experiment. They are phrased as
// tendencies, not certainties: the observer has to keep testing them.
import type { Q } from '../db.js';
import { KNOWLEDGE_DOMAINS } from './laws.js';

interface Def { key: string; domain: string; points: number; text: string; test: (s: any) => boolean }
const n = (s: any, k: string) => s.outcomes?.[k] || 0;
const a = (s: any, k: string) => s.actions?.[k] || 0;

export const DISCOVERIES: Def[] = [
  { key: 'observer_effect', domain: 'probability', points: 3, test: (s) => n(s, 'observe:perturb') >= 1,
    text: 'Observation is not passive. Looking at an object can shift its stability.' },
  { key: 'low_stability', domain: 'entropy', points: 3, test: (s) => (s.lowStabChange || 0) >= 2,
    text: 'Objects with stability below 20 tend to transform.' },
  { key: 'conservation', domain: 'energy', points: 3, test: (s) => a(s, 'energize') >= 3 && a(s, 'draw') >= 1,
    text: 'Energy is never created here. Whatever you spend goes somewhere.' },
  { key: 'thresholds', domain: 'energy', points: 4, test: (s) => (s.formChanges || 0) >= 1,
    text: 'Enough energy pushes matter toward a new form. Each form seems to have a threshold.' },
  { key: 'entropy_cost', domain: 'entropy', points: 3, test: (s) => a(s, 'stabilize') >= 3,
    text: 'Order in one place appears to be paid for with disorder elsewhere.' },
  { key: 'bonds', domain: 'gravity', points: 3, test: (s) => n(s, 'connect:bond') >= 2,
    text: 'Bonded objects share their fate. What is bonded to a star seems to be fed by it.' },
  { key: 'merging', domain: 'gravity', points: 3, test: (s) => n(s, 'connect:merge') >= 1,
    text: 'Simple things combine into complex things. Complexity adds up.' },
  { key: 'unexplored', domain: 'probability', points: 3, test: (s) => a(s, 'explore') >= 3,
    text: 'An unexplored region has no recorded state until someone arrives.' },
  { key: 'other_observers', domain: 'probability', points: 3, test: (s) => (s.shared || 0) >= 1,
    text: 'Other observers have shaped what you see. Their past acts bend your odds.' },
  { key: 'anomalies', domain: 'probability', points: 4, test: (s) => (s.anomalies || 0) >= 1,
    text: 'Rare outcomes are part of the law, not exceptions to it.' },
  { key: 'determinism', domain: 'probability', points: 4, test: (s) => (s.verified || 0) >= 1,
    text: 'The same state met by the same interaction always collapses the same way.' },
  { key: 'decay', domain: 'entropy', points: 3, test: (s) => (s.collapses || 0) >= 1,
    text: 'Left alone, fragile things decay. Attention may be a kind of maintenance.' },
  { key: 'intent', domain: 'probability', points: 3, test: (s) => (s.focused || 0) >= 3,
    text: 'Focus bends the distribution toward your intent. It never fixes the outcome.' },
  { key: 'replication', domain: 'life', points: 5, test: (s) => a(s, 'signal') >= 1,
    text: 'Some systems respond. Whether they understand is not yet known.' },
  { key: 'signals', domain: 'probability', points: 2, test: (s) => (s.signals || 0) >= 1,
    text: 'A signal left on an object stays there. Whether anything reads it is another matter.' },
  { key: 'echoes', domain: 'probability', points: 3, test: (s) => (s.echoes || 0) >= 2,
    text: 'An echo proves that something noticed. It does not prove that someone did.' },
  { key: 'contact', domain: 'life', points: 8, test: (s) => (s.contacts || 0) >= 1,
    text: 'Some echoes are other observers. Only an answered echo tells you which.' },
  { key: 'answered', domain: 'life', points: 8, test: (s) => n(s, 'signal:reply') >= 1,
    text: 'Something answered. Observation may run in both directions.' },
];

export function addKnowledge(user: any, domain: string, points: number) {
  user.domains = { ...user.domains, [domain]: (user.domains?.[domain] || 0) + points };
  user.knowledge = KNOWLEDGE_DOMAINS.reduce((s, d) => s + (user.domains[d] || 0), 0);
}

export async function evaluateDiscoveries(q: Q, user: any, tick: number, objectId: number | null) {
  const found: { key: string; text: string; domain: string }[] = [];
  const have = new Set((await q('SELECT key FROM discoveries WHERE user_id = $1', [user.id])).map((r) => r.key));
  for (const d of DISCOVERIES) {
    if (have.has(d.key) || !d.test(user.stats)) continue;
    await q('INSERT INTO discoveries (user_id, discovery_type, key, object_id, description, discovered_tick) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [user.id, 'law', d.key, objectId, d.text, tick]);
    addKnowledge(user, d.domain, d.points);
    found.push({ key: d.key, text: d.text, domain: d.domain });
  }
  return found;
}
