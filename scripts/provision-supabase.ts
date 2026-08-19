/**
 * RONOR — Supabase Schema Provisioning
 * ─────────────────────────────────────
 * Executes the SQL migration in deploy/sql/001_ronor_schema.sql against the
 * Supabase project mrmauhtdmmyaxrxfsqsn.
 *
 * Uses the Supabase Management API (POST /v1/projects/{ref}/database/query)
 * rather than a direct Postgres connection, so it works from any machine with
 * internet access and does not require the Postgres password.
 *
 * Usage
 * ─────
 *   SUPABASE_SERVICE_ROLE_KEY=<key> ts-node scripts/provision-supabase.ts
 *   node dist/scripts/provision-supabase.js
 *
 * Idempotent: re-running against an already-migrated project is safe.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { createLogger } from '../src/utils/logger';

const logger = createLogger('RONOR:Provision:Supabase');

const SUPABASE_URL     = (process.env.SUPABASE_URL ?? 'https://mrmauhtdmmyaxrxfsqsn.supabase.co').replace(/\/+$/, '');
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const PROJECT_REF      = SUPABASE_URL.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? '';

function post(url: string, key: string, body: unknown): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        apikey: key,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60_000,
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let data: unknown;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('request timed out')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runSql(sql: string): Promise<void> {
  // Supabase Management API: POST /v1/projects/{ref}/database/query
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  logger.info(`Executing SQL via Management API → ${url}`);

  const { status, data } = await post(url, SERVICE_ROLE_KEY, { query: sql });

  if (status >= 400) {
    logger.error(`Management API returned HTTP ${status}:`, data);
    throw new Error(`SQL execution failed with HTTP ${status}`);
  }
  logger.info(`SQL executed successfully (HTTP ${status})`);
}

async function main(): Promise<void> {
  if (!SERVICE_ROLE_KEY) {
    logger.error('SUPABASE_SERVICE_ROLE_KEY is not set. Cannot provision schema.');
    process.exit(1);
  }
  if (!PROJECT_REF) {
    logger.error(`Cannot extract project ref from SUPABASE_URL: ${SUPABASE_URL}`);
    process.exit(1);
  }

  logger.info(`Provisioning Supabase project ${PROJECT_REF}`);
  logger.info(`Service role key present: yes (${SERVICE_ROLE_KEY.length} chars)`);

  const sqlPath = path.resolve(__dirname, '../deploy/sql/001_ronor_schema.sql');
  if (!fs.existsSync(sqlPath)) {
    logger.error(`SQL file not found: ${sqlPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');
  logger.info(`SQL file loaded: ${sqlPath} (${sql.length} chars)`);

  await runSql(sql);

  logger.info('Supabase schema provisioning complete.');
  logger.info('Tables created (if not already existing):');
  logger.info('  ronor.conversations');
  logger.info('  ronor.memory_entries');
  logger.info('  ronor.agent_state');
  logger.info('  ronor.missions');
  logger.info('  ronor.audit_events');
  logger.info('  ronor.schema_migrations');
}

void main().catch((err) => {
  logger.error('Unhandled error:', err);
  process.exit(1);
});
