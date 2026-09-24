import crypto from 'crypto';
import { getDb } from '../../audit/hash-chain';
import { createMission, getMission } from '../mission/store';
import { sanitiseFreeText, sanitiseIdentifier } from '../api/sanitize';

export interface DevelopmentJob {
  job_id: string;
  mission_id: string;
  created_at: string;
}

/** Preparing intent grants no mandate and invokes no model, tool or executor. */
export function prepareDevelopmentJob(input: {
  architectKeyId: string; idempotencyKey: string; objective: string;
}): { job: DevelopmentJob; created: boolean } {
  const key = sanitiseIdentifier(input.idempotencyKey, 120);
  const objective = sanitiseFreeText(input.objective, 8000);
  if (!key || key !== input.idempotencyKey || !objective ||
      input.objective.length > 8000 || !input.architectKeyId) {
    throw new Error('invalid_development_job');
  }
  const jobId = `dev_${crypto.createHash('sha256')
    .update(JSON.stringify([input.architectKeyId, key])).digest('hex')}`;
  const objectiveHash = crypto.createHash('sha256').update(objective).digest('hex');
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_development_jobs (
    job_id TEXT PRIMARY KEY,
    objective_hash TEXT NOT NULL,
    mission_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  )`);
  return db.transaction(() => {
    const prior = db.prepare('SELECT * FROM runtime_development_jobs WHERE job_id = ?')
      .get(jobId) as (DevelopmentJob & { objective_hash: string }) | undefined;
    if (prior) {
      if (prior.objective_hash !== objectiveHash) throw new Error('development_job_conflict');
      const mission = getMission(prior.mission_id);
      if (!mission || crypto.createHash('sha256').update(mission.objective).digest('hex') !== objectiveHash) {
        throw new Error('development_job_integrity_failed');
      }
      return {
        created: false,
        job: { job_id: prior.job_id, mission_id: prior.mission_id, created_at: prior.created_at },
      };
    }
    const mission = createMission({ title: 'Dezvoltare RONOR', objective, operatorId: 'merlin' });
    const job: DevelopmentJob = {
      job_id: jobId, mission_id: mission.mission_id, created_at: new Date().toISOString(),
    };
    db.prepare(`INSERT INTO runtime_development_jobs
      (job_id, objective_hash, mission_id, created_at) VALUES (?, ?, ?, ?)`)
      .run(job.job_id, objectiveHash, job.mission_id, job.created_at);
    return { created: true, job };
  }).immediate();
}
