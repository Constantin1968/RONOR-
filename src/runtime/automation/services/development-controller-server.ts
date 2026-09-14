import fs from 'fs';
import path from 'path';
import { bootstrapApiKeys } from '../../api/auth';
import { ensureRuntimeLedgerSchema } from '../../ledgers/schema';
import { createDevelopmentController } from '../development-controller';
import { secretValue } from './secret-files';

export const CONTROLLER_SECRETS = [
  'RONOR_ARCHITECT_API_KEY', 'RONOR_AUTOMATION_MANDATE_SIGNING_KEY',
  'RONOR_LANGGRAPH_TOKEN', 'RONOR_OPENHANDS_TOKEN', 'RONOR_AUTOMATION_CAPABILITY_KEY',
  'RONOR_CODEX_VERIFIER_TOKEN', 'RONOR_ASSURANCE_TOKEN', 'RONOR_EVIDENCE_RUNNER_TOKEN',
] as const;

export function controllerEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Do not inherit model, GitHub, SSH or legacy runtime credentials.
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith('RONOR_AUTOMATION_') ||
        ['RONOR_LANGGRAPH_URL', 'RONOR_OPENHANDS_URL', 'RONOR_CODEX_VERIFIER_URL',
          'RONOR_ASSURANCE_URL', 'RONOR_EVIDENCE_RUNNER_URL',
          // Address of the read-only budget settlement, so a run that ended
          // without reporting a cost can still be accounted for. It is an
          // address, not a credential: the read is signed with the capability
          // key, and no model gateway client token is inherited here.
          'RONOR_MODEL_EGRESS_URL'].includes(name)) env[name] = value;
  }
  for (const name of CONTROLLER_SECRETS) {
    const secret = secretValue(name, source);
    if (!secret || Buffer.byteLength(secret) < 32) throw new Error('controller_secret_missing_or_short');
    env[name] = secret;
  }
  if (new Set(CONTROLLER_SECRETS.map(name => env[name])).size !== CONTROLLER_SECRETS.length) {
    throw new Error('controller_secret_identity_conflict');
  }
  // Recovery is opt-in, not an accidental side effect of starting a new process.
  env.RONOR_AUTOMATION_RECOVERY_ENABLED = source.RONOR_AUTOMATION_RECOVERY_ENABLED === 'true' ? 'true' : 'false';
  return env;
}

export function startDevelopmentController() {
  const env = controllerEnvironment(process.env);
  const dbPath = process.env.AUDIT_DB_PATH;
  if (!dbPath || !path.isAbsolute(dbPath) || !fs.statSync(path.dirname(dbPath)).isDirectory()) {
    throw new Error('controller_persistent_store_required');
  }
  const port = Number(process.env.RONOR_DEVELOPMENT_PORT || 3010);
  const host = process.env.RONOR_DEVELOPMENT_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1024 || port > 65535 ||
      !['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('controller_listener_invalid');
  // 0.0.0.0 is only for the explicitly isolated container; Compose publishes loopback.
  ensureRuntimeLedgerSchema();
  bootstrapApiKeys(env);
  const controller = createDevelopmentController(env);
  const server = controller.app.listen(port, host, () => {
    process.stdout.write('RONOR development controller started; use authenticated readiness before execution.\n');
  });
  const shutdown = () => { controller.stop(); server.close(); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return { server, stop: shutdown };
}

if (require.main === module) {
  try { startDevelopmentController(); }
  catch {
    // Never serialize startup exceptions: a filesystem or provider error may contain secrets.
    process.stderr.write('Development controller startup refused; check required configuration and secret files.\n');
    process.exitCode = 1;
  }
}
