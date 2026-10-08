// THE LAWS OF THIS UNIVERSE
// Every number that shapes reality lives in this file. The engine reads the
// laws; it never hard-codes them. Change a law here and the universe obeys.
// These are game rules inspired by physics, not claims about real physics.

export type Weights = Record<string, number>;
export interface Ctx {
  action: string;
  type: string; state: string; stability: number; energy: number; complexity: number; information: number;
  regionEntropy: number; regionState: string; converged: boolean; globalEntropy: number;
  observers: number;          // other observers who have interacted with this object
  focus: number; amount: number;
  hasNextForm: boolean; canSplit: boolean; bonds: number; bondedToStar: boolean;
  targetType: string | null; canMerge: boolean; existingBond: boolean;
  regionExists: boolean;
}
export interface Modifier { label: string; when: (c: Ctx) => boolean; mult: (c: Ctx) => Weights }

export const REGION_SIZE = 240;

export const LAW_ENERGY_CONSERVATION = {
  totalEnergy: 8_310_000,     // fixed forever: objects + observers + vacuum
  observerStart: 100,         // drawn from the vacuum when an observer arrives
  regenCap: 100,              // the vacuum slowly refills an observer up to this
  regenSeconds: 20,           // one energy per this many real seconds
  observerCap: 400,           // an observer cannot hold more than this
};

export const LAW_ENTROPY = {
  perInteraction: 1.0,        // local entropy added by a disruptive interaction
  perDissipated: 0.0004,      // global entropy per unit of energy lost to the vacuum
  stabilizeLocal: -4,         // stabilising lowers local entropy...
  stabilizeGlobal: 0.004,     // ...and exports a little to the universe
  epochGlobal: 0.01,
  epochRelax: 1.5,            // regions relax toward baseline each epoch
  baseline: 10,
  unstableAbove: 60,
  calmBelow: 40,
};

export const LAW_STABILITY = { lowThreshold: 20, highThreshold: 85 };

export const LAW_TIME = { epochTicks: 250, convergenceWindow: 4000 };

// decay: stability lost per 100 ticks. radiate: energy returned to the vacuum per 100 ticks.
export const TYPES: Record<string, { label: string; decay: number; radiate: number; floor: number; life?: boolean; massive?: boolean }> = {
  particle:     { label: 'Particle',               decay: 0.10, radiate: 0, floor: 0 },
  cluster:      { label: 'Cluster',                decay: 0.06, radiate: 0, floor: 0 },
  dust:         { label: 'Dust Cloud',             decay: 0.08, radiate: 0, floor: 0 },
  field:        { label: 'Energy Field',           decay: 0.50, radiate: 1, floor: 5 },
  core:         { label: 'Dormant Core',           decay: 0,    radiate: 0, floor: 0, massive: true },
  star:         { label: 'Star',                   decay: 0,    radiate: 3, floor: 40, massive: true },
  planet:       { label: 'Planet',                 decay: 0.01, radiate: 0, floor: 0, massive: true },
  anomaly:      { label: 'Anomaly',                decay: 2.00, radiate: 0, floor: 0 },
  remnant:      { label: 'Remnant',                decay: 0,    radiate: 0, floor: 0 },
  replicator:   { label: 'Self-Replicating System', decay: 0.30, radiate: 1, floor: 5, life: true },
  organism:     { label: 'Proto-Organism',         decay: 0.20, radiate: 1, floor: 5, life: true },
  ecosystem:    { label: 'Ecosystem',              decay: 0.08, radiate: 2, floor: 20, life: true },
  intelligence: { label: 'Civilization',           decay: 0.04, radiate: 3, floor: 50, life: true, massive: true },
  singularity:  { label: 'Singularity',            decay: 0,    radiate: 0, floor: 0, massive: true },
};

export const LAW_DECAY = { excitedFactor: 2 };

export const LAW_EMERGENCE = {
  starIgnition: 1000,         // a dormant core holding this much energy ignites
  singularity: 6000,          // a star holding this much collapses inward
  starDeath: 45,
  forms: {                    // energy a thing must hold before it can take its next form
    remnantToParticle: 20, particleToField: 60, fieldToDust: 150, clusterToDust: 80, clusterComplexity: 3,
    dustToCore: 250, toPlanet: 150, replicatorToOrganism: 80, organismToEcosystem: 150, ecosystemToIntelligence: 300,
  },
  convergenceObservers: 3,    // distinct observers in one region
  collectiveObservers: 3,     // distinct observers feeding one object
  lifeComplexity: 30, lifeChance: 0.02, lifePerObserver: 0.005,
};

// LAW_GRAVITY: what matter does when nobody is watching.
export const LAW_GRAVITY = {
  // Unattended star formation slows as the universe ages. Each row: [until this real age in seconds, one star every N seconds].
  starSchedule: [[1800, 60], [86400, 3600], [604800, 86400], [2592000, 604800], [31536000, 2592000], [Infinity, 31536000]] as [number, number][],
  maxStarsPerFrame: 12,        // catching up after a long sleep is spread over several frames
  naturalStarsPerRegion: 3,
  starEnergy: [1100, 2400],    // a new star's energy; it radiates this away over days and then dies
  regionsPerEpoch: 12,
  drift: 0.05,                 // fraction of the distance light things fall toward the heaviest thing nearby, per epoch
  mergeWithin: 45, mergeChance: 0.6,
  clusterToDustComplexity: 4,
  dustAccretion: 8, dustCap: 400, dustToCoreChance: 0.25,
  coreAccretion: 12, coreCap: 950,   // a core gathers itself almost to ignition; the last step needs time or observers
  fluctuationChance: 0.3,      // a quiet region occasionally gains a particle from the vacuum
  captureWithin: 170, captureChance: 0.4, planetChance: 0.5,
  supernovaDust: [2, 3],
  maxCoresPerRegion: 2, crowdedRegion: 14,
  // Stars burn at different rates. A few are giants that die within days; most are dwarfs that last months.
  giantChance: 0.2, giantLifeDays: [4, 8], dwarfLifeDays: [60, 400], ticksPerDay: 7200,
  remnantFadeTicks: 20000,     // old remnants fade from the map; their rows and history remain
};

export const ERAS = ['The Dust Age', 'The First Light', 'The Age of Ashes', 'The Age of Worlds', 'The Living Age', 'The Thinking Age'];

export function starsDue(ageSeconds: number) {
  let n = 0, t = 0;
  for (const [until, every] of LAW_GRAVITY.starSchedule) {
    const end = Math.min(ageSeconds, until);
    if (end > t) n += (end - t) / every;
    if (ageSeconds <= until) break;
    t = until;
  }
  return Math.floor(n);
}

export const LAW_REPLICATION = { energyNeeded: 60, chance: 0.35, starFeed: 6, maxPerEpoch: 20 };

// ---- LAW_INTERACTION ---------------------------------------------------------
export interface Action {
  label: string; verb: string; cost: number; ticks: number; domain: string;
  needs?: 'object' | 'target' | 'region' | 'point';
  amounts?: number[]; focusable?: boolean; primary?: string[];
  base: Weights; outcomes: Record<string, string>; only?: (type: string) => boolean;
}
const notRemnant = (t: string) => t !== 'remnant';
export const ACTIONS: Record<string, Action> = {
  observe: {
    label: 'Observe', verb: 'observed', cost: 1, ticks: 1, domain: 'probability', needs: 'object',
    base: { clear: 60, perturb: 20, deep: 15, elusive: 5 },
    outcomes: { clear: 'A clear reading', perturb: 'Your looking changed it', deep: 'A deep insight', elusive: 'It slipped away' },
  },
  touch: {
    label: 'Touch', verb: 'touched', cost: 3, ticks: 2, domain: 'probability', needs: 'object', focusable: true, primary: ['stabilize'],
    base: { stabilize: 50, transform: 30, split: 15, anomaly: 5 }, only: notRemnant,
    outcomes: { stabilize: 'It stabilises', transform: 'It changes state', split: 'It splits', anomaly: 'Something unexpected' },
  },
  energize: {
    label: 'Give energy', verb: 'gave energy to', cost: 0, ticks: 2, domain: 'energy', needs: 'object', amounts: [5, 15, 40],
    base: { absorb: 50, excite: 22, transform: 15, split: 8, anomaly: 5 },
    outcomes: { absorb: 'It absorbs the energy', excite: 'It becomes excited', transform: 'It changes state', split: 'It splits', anomaly: 'Something unexpected' },
  },
  draw: {
    label: 'Draw energy', verb: 'drew energy from', cost: 1, ticks: 2, domain: 'energy', needs: 'object', amounts: [5, 15, 40], only: notRemnant,
    base: { clean: 55, leak: 20, destabilize: 18, collapse: 5, anomaly: 2 },
    outcomes: { clean: 'A clean transfer', leak: 'Half of it leaks away', destabilize: 'It is left unstable', collapse: 'It collapses', anomaly: 'Something unexpected' },
  },
  connect: {
    label: 'Connect', verb: 'connected', cost: 8, ticks: 3, domain: 'gravity', needs: 'target', focusable: true, primary: ['bond'], only: notRemnant,
    base: { bond: 45, resonance: 20, repel: 20, merge: 10, anomaly: 5 },
    outcomes: { bond: 'A bond forms', resonance: 'They resonate', repel: 'They repel', merge: 'They merge into one', anomaly: 'Something unexpected' },
  },
  separate: {
    label: 'Separate', verb: 'pulled apart', cost: 6, ticks: 3, domain: 'gravity', needs: 'object', focusable: true, primary: ['break'], only: notRemnant,
    base: { break: 50, holds: 30, split: 15, anomaly: 5 },
    outcomes: { break: 'A bond breaks', holds: 'It holds together', split: 'It splits', anomaly: 'Something unexpected' },
  },
  stabilize: {
    label: 'Stabilise', verb: 'stabilised', cost: 10, ticks: 3, domain: 'entropy', needs: 'object', focusable: true, primary: ['settle', 'lock'], only: notRemnant,
    base: { settle: 55, lock: 20, nothing: 18, backfire: 7 },
    outcomes: { settle: 'It settles', lock: 'It locks into order', nothing: 'No effect', backfire: 'It backfires' },
  },
  signal: {
    label: 'Call to it', verb: 'called to', cost: 5, ticks: 2, domain: 'life', needs: 'object', focusable: true, primary: ['adapts', 'reply'],
    only: (t) => !!TYPES[t]?.life || t === 'anomaly',
    base: { silence: 50, reacts: 28, adapts: 15, reply: 7 },
    outcomes: { silence: 'Silence', reacts: 'It reacts', adapts: 'It adapts', reply: 'It answers' },
  },
  unmake: {
    label: 'Unmake', verb: 'tried to unmake', cost: 20, ticks: 5, domain: 'entropy', needs: 'object', focusable: true, primary: ['unmade'], only: notRemnant,
    base: { unmade: 40, resists: 40, burst: 15, anomaly: 5 },
    outcomes: { unmade: 'It is unmade', resists: 'It resists', burst: 'It bursts outward', anomaly: 'Something unexpected' },
  },
  create: {
    label: 'Create', verb: 'created', cost: 25, ticks: 5, domain: 'energy', needs: 'point',
    base: { particle: 55, dust: 22, field: 15, fizzle: 5, anomaly: 3 },
    outcomes: { particle: 'A particle condenses', dust: 'A dust cloud gathers', field: 'An energy field opens', fizzle: 'It fades before it forms', anomaly: 'Something unexpected' },
  },
  explore: {
    label: 'Explore', verb: 'explored', cost: 4, ticks: 4, domain: 'probability', needs: 'region',
    base: { sparse: 40, scatter: 25, dust: 15, empty: 10, structure: 8, anomaly: 2, arrival: 0 },
    outcomes: { sparse: 'A few particles', scatter: 'A field of particles', dust: 'Drifting dust', empty: 'Nothing. Yet.', structure: 'A structure', anomaly: 'Something unexpected', arrival: 'This region already has a history' },
  },
};

// How circumstances bend the distribution. Each rule multiplies some weights.
const BAD = { excite: 1.3, destabilize: 1.3, backfire: 1.3, repel: 1.3, collapse: 1.3 };
export const MODIFIERS: Modifier[] = [
  { label: 'Low stability: it is ready to change', when: (c) => c.stability < LAW_STABILITY.lowThreshold,
    mult: () => ({ transform: 2, split: 1.5, collapse: 3, stabilize: 0.7, unmade: 1.6 }) },
  { label: 'High stability: it resists change', when: (c) => c.stability > LAW_STABILITY.highThreshold,
    mult: () => ({ transform: 0.5, split: 0.5, collapse: 0.3, excite: 0.7, break: 0.7 }) },
  { label: 'On the edge of a new form', when: (c) => c.hasNextForm, mult: () => ({ transform: 2.5 }) },
  { label: 'Excited state', when: (c) => c.state === 'excited', mult: () => ({ transform: 1.5, split: 1.5, excite: 0.6, destabilize: 1.4 }) },
  { label: 'Resonant state', when: (c) => c.state === 'resonant', mult: () => ({ stabilize: 1.4, settle: 1.3, bond: 1.4, anomaly: 2, reply: 2 }) },
  { label: 'A large amount of energy at once', when: (c) => c.amount >= 40, mult: () => ({ excite: 1.5, transform: 1.6, destabilize: 1.5, split: 1.3 }) },
  { label: 'A gentle amount of energy', when: (c) => c.amount > 0 && c.amount <= 5, mult: () => ({ absorb: 1.3, clean: 1.3 }) },
  { label: 'Your focus sharpens your intent', when: (c) => c.focus > 1,
    mult: (c) => Object.fromEntries((ACTIONS[c.action].primary || []).map((o) => [o, 1 + 0.7 * (c.focus - 1)])) },
  { label: 'Other observers have influenced this', when: (c) => c.observers > 0,
    mult: (c) => ({ anomaly: 1 + 0.1 * Math.min(c.observers, 5), transform: 1 + 0.05 * Math.min(c.observers, 10), deep: 1 + 0.1 * Math.min(c.observers, 10) }) },
  { label: 'High local entropy', when: (c) => c.regionEntropy > 35, mult: () => ({ ...BAD, anomaly: 1.5 }) },
  { label: 'This region is unstable', when: (c) => c.regionState === 'unstable', mult: () => ({ ...BAD, backfire: 2, anomaly: 1.5, perturb: 1.5 }) },
  { label: 'Convergence: many observers have met here', when: (c) => c.converged, mult: () => ({ anomaly: 1.6, deep: 1.4, resonance: 1.4, structure: 2 }) },
  { label: 'The universe is ageing', when: (c) => c.globalEntropy > 50, mult: (c) => ({ anomaly: 1 + (c.globalEntropy - 50) / 100, collapse: 1.2 }) },
  { label: 'Both are simple enough to merge', when: (c) => c.action === 'connect' && c.canMerge, mult: () => ({ merge: 3 }) },
  { label: 'They are already bonded', when: (c) => c.existingBond, mult: () => ({ bond: 1.3, resonance: 1.5, repel: 0.5 }) },
  { label: 'It is fed by a star', when: (c) => c.bondedToStar, mult: () => ({ adapts: 1.5, absorb: 1.2, collapse: 0.5 }) },
  { label: 'Its long history holds it together', when: (c) => c.action === 'unmake' && c.information > 20,
    mult: (c) => ({ resists: 1 + Math.log10(1 + c.information) }) },
  { label: 'Stable things resist being unmade', when: (c) => c.action === 'unmake', mult: (c) => ({ resists: 0.5 + c.stability / 50 }) },
  { label: 'It is too vast to simply unmake', when: (c) => c.action === 'unmake' && !!TYPES[c.type]?.massive, mult: () => ({ resists: 8, burst: 0.3 }) },
  { label: 'A mind is listening', when: (c) => c.action === 'signal' && c.type === 'intelligence', mult: () => ({ reply: 4, silence: 0.5 }) },
];

// Outcomes that are impossible in the current circumstances get zero weight,
// so the distribution shown to the observer is always the honest one.
export function eligibility(c: Ctx): Weights {
  const z: Weights = {};
  if (!c.canSplit) z.split = 0;
  if (c.action === 'connect' && !c.canMerge) z.merge = 0;
  if (c.action === 'separate' && c.bonds === 0) z.break = 0;
  if (c.action === 'draw' && (c.type === 'core' || c.type === 'singularity')) z.collapse = 0;
  if (c.action === 'explore') {
    if (c.regionExists) Object.assign(z, { sparse: 0, scatter: 0, dust: 0, empty: 0, structure: 0, anomaly: 0, arrival: 1 });
  }
  return z;
}

export const KNOWLEDGE_DOMAINS = ['energy', 'entropy', 'probability', 'gravity', 'life'];
export const level = (points: number) => Math.floor(Math.sqrt((points || 0) / 3));

export const RANKS = [
  { title: 'Unknown Observer', test: () => true },
  { title: 'Explorer', test: (s: any) => (s.actions?.explore || 0) >= 1 && s.total >= 10 },
  { title: 'Interactor', test: (s: any) => s.total >= 50 },
  { title: 'Creator', test: (s: any) => s.total >= 50 && (s.created || 0) >= 3 },
  { title: 'Architect', test: (s: any, u: any) => s.total >= 150 && u.influence >= 25 },
  { title: 'Cosmic Observer', test: (s: any, u: any) => s.total >= 500 && u.knowledge >= 80 && u.influence >= 100 },
];
export function rankOf(u: { stats: any; influence: number; knowledge: number }) {
  const s = { total: 0, ...u.stats };
  let r = RANKS[0].title;
  for (const k of RANKS) if (k.test(s, u)) r = k.title;
  return r;
}
