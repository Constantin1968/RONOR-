/**
 * Linia de comandă a executorului cu mandat, pentru rularea pe gazdă sub un
 * utilizator dedicat, fără socket Docker.
 *
 *   ronor-executor status
 *   ronor-executor stop "<motiv>"            # STOP persistent; oprește și ce e în curs
 *   ronor-executor clear-stop <cine>
 *   ronor-executor revoke-mandate <mandate_id> "<motiv>"
 *   ronor-executor revoke-approval <approval_id> "<motiv>"
 *   ronor-executor action-hash  < cerere.json   # hash-ul pe care îl aprobă omul
 *   ronor-executor approve <key_id> <ttl_sec> < cerere.json
 *   ronor-executor execute      < cerere.json
 *
 * Configurația vine din mediu: RONOR_EXECUTOR_CATALOG (JSON-ul listei albe),
 * RONOR_EXECUTOR_DB (jurnalul SQLite), RONOR_EXECUTOR_STOP_FILE (opțional) și
 * cele trei chei, citite din fișiere: RONOR_EXECUTOR_MANDATE_KEY_FILE,
 * RONOR_EXECUTOR_APPROVAL_KEY_FILE, RONOR_EXECUTOR_RECEIPT_KEY_FILE.
 * Nicio cheie nu se primește în argumente sau în cerere.
 */
import fs from 'node:fs';
import { actionHash, signActuationApproval } from './approval';
import { parseExecutorCatalog, planAction } from './catalog';
import { MandatedExecutor, type ExecutionRequest } from './executor';
import { ExecutorJournal } from './journal';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function readKey(name: string): string {
  return fs.readFileSync(required(name), 'utf8').trim();
}

function readStdinJson(): unknown {
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const catalog = parseExecutorCatalog(JSON.parse(fs.readFileSync(required('RONOR_EXECUTOR_CATALOG'), 'utf8')));
  const journal = new ExecutorJournal(required('RONOR_EXECUTOR_DB'));
  try {
    if (command === 'action-hash' || command === 'approve') {
      const request = readStdinJson() as ExecutionRequest;
      const action = request.action as { type: string; args: Record<string, unknown> };
      const planned = planAction(catalog, action);
      if (!planned.ok) {
        print({ refused: planned.reason });
        return 2;
      }
      const hash = actionHash({ host_id: catalog.host_id, mandate_id: request.mandate.mandate_id, type: action.type, args: action.args, resource: planned.plan.resource });
      if (command === 'action-hash') {
        print({ host_id: catalog.host_id, mandate_id: request.mandate.mandate_id, action, resource: planned.plan.resource, action_hash: hash });
        return 0;
      }
      const [keyId, ttl] = rest;
      print(signActuationApproval({ mandateId: request.mandate.mandate_id, actionHash: hash, approverKeyId: keyId, ttlMs: Number(ttl) * 1000 }, readKey('RONOR_EXECUTOR_APPROVAL_KEY_FILE')));
      return 0;
    }

    const executor = MandatedExecutor.create({
      catalog,
      journal,
      mandateSecret: readKey('RONOR_EXECUTOR_MANDATE_KEY_FILE'),
      approvalSecret: readKey('RONOR_EXECUTOR_APPROVAL_KEY_FILE'),
      receiptSecret: readKey('RONOR_EXECUTOR_RECEIPT_KEY_FILE'),
      stopFile: process.env.RONOR_EXECUTOR_STOP_FILE,
    });
    switch (command) {
      case 'status':
        print(executor.status());
        return 0;
      case 'stop':
        executor.stop(rest[0] ?? 'fără motiv');
        print(executor.status());
        return 0;
      case 'clear-stop':
        if (!rest[0]) throw new Error('clear_stop_requires_actor');
        executor.clearStop(rest[0]);
        print(executor.status());
        return 0;
      case 'revoke-mandate':
        executor.revokeMandate(rest[0], rest[1] ?? 'fără motiv');
        return 0;
      case 'revoke-approval':
        executor.revokeApproval(rest[0], rest[1] ?? 'fără motiv');
        return 0;
      case 'execute': {
        const outcome = await executor.execute(readStdinJson() as ExecutionRequest);
        print(outcome);
        return outcome.state === 'done' ? 0 : 1;
      }
      default:
        process.stderr.write('comenzi: status | stop | clear-stop | revoke-mandate | revoke-approval | action-hash | approve | execute\n');
        return 64;
    }
  } finally {
    journal.close();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(70);
    },
  );
}
