// One small adapter over two engines: real PostgreSQL (DATABASE_URL) or the
// embedded PGlite build of Postgres for zero-setup local play.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export type Q = <T = any>(sql: string, params?: any[]) => Promise<T[]>;
export interface DB {
  q: Q;
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  kind: string;
}

const norm = (rows: any[]) => {
  for (const r of rows) for (const k in r) if (typeof r[k] === 'bigint') r[k] = Number(r[k]);
  return rows;
};

async function openPg(url: string): Promise<DB> {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, Number); // int8
  pg.types.setTypeParser(1700, parseFloat); // numeric
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: 'postgres',
    q: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => { await pool.query(sql); },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, params) => (await c.query(sql, params)).rows);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openLite(dir: string): Promise<DB> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dir !== 'memory://') fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return {
    kind: 'pglite',
    q: async (sql, params) => norm((await db.query(sql, params)).rows as any[]),
    exec: async (sql) => { await db.exec(sql); },
    tx: (fn) => db.transaction((t) => fn(async (sql, params) => norm((await t.query(sql, params)).rows as any[]))) as Promise<any>,
    close: () => db.close(),
  };
}

export async function openDb(): Promise<DB> {
  const db = config.databaseUrl ? await openPg(config.databaseUrl) : await openLite(config.dataDir);
  await migrate(db);
  return db;
}

export async function migrate(db: DB) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, '..', 'migrations');
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.q('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await db.exec('BEGIN;\n' + fs.readFileSync(path.join(dir, f), 'utf8') + '\nCOMMIT;');
    await db.q('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    console.log('[db] applied migration', f);
  }
}

if (process.argv[2] === 'migrate') {
  openDb().then(async (db) => { console.log('[db] schema is up to date on', db.kind); await db.close(); });
}
