import 'dotenv/config';
import crypto from 'node:crypto';

const env = process.env;
let jwtSecret = env.JWT_SECRET || '';
if (!jwtSecret) {
  if (env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET not set - using a temporary one (logins end when the server restarts)');
}

export const config = {
  databaseUrl: env.DATABASE_URL || '',
  dataDir: env.DATA_DIR || '.data/universe',
  jwtSecret,
  port: Number(env.PORT || 3000),
  corsOrigin: env.CORS_ORIGIN || '',
  heartbeatSeconds: Number(env.HEARTBEAT_SECONDS ?? 60),
  heartbeatTicks: Number(env.HEARTBEAT_TICKS ?? 5),
  trustProxy: env.TRUST_PROXY === '1',
  authRateMax: Number(env.AUTH_RATE_MAX || 30),
  actRateMax: Number(env.ACT_RATE_MAX || 90),
};
