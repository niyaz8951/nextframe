import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { genesis } from './engine/seed.js';
import { heartbeat } from './engine/interact.js';
import { api } from './routes.js';

const db = await openDb();
if (await genesis(db)) console.log('[genesis] the universe has begun');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } },
}));
if (config.corsOrigin) {
  app.use((req, res, next) => {
    if (req.headers.origin === config.corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}
app.use(express.json({ limit: '16kb' }));
app.use('/api', api(db));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, '..', 'public'), {
  maxAge: '5m',
  setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); },
}));

// Background drift: the universe keeps moving when no one is acting.
if (config.heartbeatSeconds > 0 && config.heartbeatTicks > 0) {
  setInterval(() => heartbeat(db).catch((e) => console.error('[heartbeat]', e.message)), config.heartbeatSeconds * 1000).unref();
}

const server = app.listen(config.port, () => console.log(`THE NEXT FRAME is running on http://localhost:${config.port} (${db.kind})`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => db.close().finally(() => process.exit(0))));
