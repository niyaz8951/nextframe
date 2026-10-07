# The Next Frame

> Reality doesn't exist until something interacts with it.

One persistent universe shared by every player. You observe things, interact with
them, and every interaction is resolved by a probability distribution that you can
see, bend, and never fully control. Whatever happens is written into the universe
for everyone, permanently. There is no reset.

This is a game inspired by ideas from quantum mechanics and information theory.
It does not claim to describe how reality actually works.

MVP v0.1 covers Phase 1 and Phase 2 of the design, plus the working core of
Phase 3 (emergence, simple life) and a few Phase 4 pieces (anomalies, singularities).

## Run it

Requires Node.js 20 or newer.

```bash
npm install
npm run dev          # http://localhost:3000
```

With no `DATABASE_URL`, the game runs on an embedded Postgres (PGlite) stored in
`./.data`, so there is nothing else to install. For anything real, use PostgreSQL:

```bash
cp .env.example .env     # set DATABASE_URL and JWT_SECRET
npm run dev
```

The schema is migrated and the universe is seeded automatically on first start.
Genesis runs exactly once. Starting the server again never regenerates anything.

| Command | What it does |
| --- | --- |
| `npm run dev` | Start with live reload |
| `npm run build` then `npm start` | Compile and run for production |
| `npm run migrate` | Apply pending migrations only |
| `npm run seed` | Run genesis (does nothing if the universe exists) |
| `npm test` | End-to-end engine check on a throwaway in-memory universe |

## How to play

1. Begin a life. You arrive at the current universe tick with 100 energy.
2. Tap a dotted circle. It is something you have never observed.
3. Pick an action. The coloured bar shows everything that could happen and how
   likely each outcome is. Outcomes you have never witnessed are unnamed, and the
   odds are blurred until you have observed the object more closely.
4. Act. A needle sweeps the bar and stops where the roll fell. The world changes.
5. Change the amount of energy or your focus and watch the odds shift before you commit.
6. Tap a dashed region to explore it. Tap empty space to create something.
7. Leave. Come back. See what the universe and the other observers did meanwhile.

Things worth trying: feed the dormant core at the origin with other players; connect
two particles; bond something to the old star next door; observe the same object
until its odds become exact; press "Re-derive it" after any outcome.

## How the engine works

```
current state -> interaction -> rules -> possibilities -> seeded selection -> new state
```

| File | Role |
| --- | --- |
| `src/engine/laws.ts` | Every rule and number in one place: actions, base odds, modifiers, thresholds, decay |
| `src/engine/probability.ts` | `calculateOutcomes(ctx)`: weights, modifiers, normalisation |
| `src/engine/rng.ts` | Seeded, reproducible rolls |
| `src/engine/interact.ts` | The interaction transaction: validate, roll, apply, record |
| `src/engine/emergence.ts` | New forms, star ignition, life, the background epoch, region generation |
| `src/engine/simulate.ts` | Lazy simulation: drift is computed in one step when something is touched |
| `src/engine/world.ts` | `Frame`: one atomic step of the universe, and the energy ledger |
| `src/engine/discoveries.ts` | The hypotheses players can earn |
| `src/engine/seed.ts` | Genesis |

**Probability is lawful, not arbitrary.** Each outcome is chosen by a roll derived
from `sha256(interaction id, hash of the prior state, object, observer, tick, action,
inputs)`. The full distribution, the context that produced it, the roll and the seed
are stored with every interaction. `GET /api/interactions/:id/verify` recomputes the
outcome from the record alone and confirms it matches.

**What bends the odds.** Stability, state, how much energy you commit, your focus,
local and global entropy, whether a region has converged, bonds, and how many other
observers have interacted with the same object. The reasons are listed under the bar.

**Energy is conserved.** Total energy is fixed at 8,310,000. It only moves between
objects, observers and the vacuum, and every movement is recorded on the interaction.
Observers recharge slowly from the vacuum up to 100; to hold more they must draw it
from the universe. `npm test` checks the ledger after every batch of interactions.

**Time.** The universe tick advances with every interaction (heavier acts advance it
further) and by a slow background heartbeat. Every 250 ticks an epoch runs: regions
relax, long-unattended fragile objects decay, stars feed what is bonded to them, and
living systems feed, replicate and occasionally become something more.

**Emergence.** Nothing below is scripted to happen at a set time:
a dormant core ignites into a star at 1,000 energy, and remembers who fed it;
three observers acting in one region cause a convergence; clusters and dust bonded to
a star can become planets; a complex, steady, star-fed planet has a small chance per
epoch of producing a self-replicating system, which can become an organism, an
ecosystem and eventually a civilisation.

**Unexplored regions have no rows in the database.** A region is given a state by
the first observer to explore it, using that interaction's seed. Later observers find
it as it was left.

**History is immutable.** `interactions` and `events` are append-only, enforced by a
database trigger. Objects are never deleted: they collapse into remnants or merge.

## API

All routes except auth and `/api/laws` need `Authorization: Bearer <token>`.

```
POST /api/auth/register            { username, email, password }
POST /api/auth/login               { login, password }
GET  /api/me                       you, plus what happened while you were away
GET  /api/universe                 everything you can currently perceive
GET  /api/universe/pulse           cheap poll: tick, your energy, what others just did
GET  /api/universe/feed            major events
GET  /api/universe/possibilities   ?type=explore&gx=&gy=   or   ?type=create&x=&y=
POST /api/universe/explore         { gx, gy }
POST /api/universe/create          { x, y }
GET  /api/objects/:id
GET  /api/objects/:id/possibilities ?type=&focus=&amount=&target=
POST /api/objects/:id/interact     { type, focus?, amount?, target? }
GET  /api/objects/:id/history      why this object exists
POST /api/objects/:id/name         { name }
POST /api/objects/:id/notes        { body }
GET  /api/interactions/:id/verify
GET  /api/users/:id                ("me" works)   GET /api/users/:id/discoveries
GET  /api/discoveries   GET /api/events   GET /api/timeline
```

The client only ever says what it wants to do. The server decides whether it is
allowed, what it costs and what happens. What the client is told about an object
is limited to what that observer has earned by observing it.

## Security

- Passwords hashed with bcrypt. Tokens are signed JWTs sent as a bearer header, so
  there is no cookie for a cross-site request to ride on.
- All SQL is parameterised. All text is escaped before it reaches the page, and a
  content security policy blocks inline and third-party scripts.
- Rate limits on sign-in (per IP) and on interactions (per observer).
- Interactions run in one database transaction with row locks, so simultaneous
  players cannot corrupt state or share a tick.
- Secrets come from the environment. `JWT_SECRET` is required in production.

Not included yet: email verification and password reset.

## Deploying

Simplest: one small Node server plus PostgreSQL.

```bash
docker compose up --build        # app on :3000, Postgres with a persistent volume
```

Or without Docker: `npm ci && npm run build && NODE_ENV=production node dist/server.js`
with `DATABASE_URL`, `JWT_SECRET` and `PORT` set. Put it behind HTTPS and set
`TRUST_PROXY=1`.

Static frontend elsewhere (for example Cloudflare Pages): upload `public/`, set
`window.API_BASE` in `public/config.js` to the API's origin, and set `CORS_ORIGIN`
on the server to the frontend's origin.

Back up the database. It is the only copy of the universe.

## Scaling notes

- Cost is driven by interactions, not by the number of objects or by time passing:
  nothing is simulated per tick, and no rows are written on a timer except one
  update to the universe row per heartbeat.
- Every interaction locks the single universe row to assign its tick. That is
  simple and correct, and comfortably handles hundreds of interactions per second.
  Beyond that, give each region its own clock and reconcile at epochs.
- `interactions` grows forever by design. Partition it by tick range and move old
  partitions to cheap storage when it gets large; object state never depends on
  reading old rows.
- Run one server process with the heartbeat enabled; set `HEARTBEAT_SECONDS=0` on
  any additional ones.
- The client polls every 8 seconds. Server-sent events would be the next step.

## Not built yet

Research groups, following regions, a second life as an Echo (the state exists, the
transition does not), monetisation, and live push updates.

Fonts: Instrument Serif and Familjen Grotesk, both under the SIL Open Font License.
