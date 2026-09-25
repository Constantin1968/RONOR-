/**
 * Linia de comandă a executorului cu mandat.
 *
 * Comenzile executorului, rulate pe gazdă ca utilizatorul dedicat `ronor-exec`,
 * fără socket Docker. Deschid jurnalul:
 *   ronor-executor status
 *   ronor-executor stop "<motiv>"            # STOP persistent; oprește și ce e în curs
 *   ronor-executor clear-stop <cine>
 *   ronor-executor revoke-mandate <mandate_id> "<motiv>"
 *   ronor-executor revoke-approval <approval_id> "<motiv>"
 *   ronor-executor execute      < cerere.json
 *
 * Comenzile omului (emitentul mandatului și cel care aprobă), rulate cu cheile
 * lor private, în afara executorului. Nu deschid jurnalul și nu citesc cheile
 * executorului (D6):
 *   ronor-executor keygen <cheie_privată_nouă> <cheie_publică_nouă>
 *   ronor-executor key-id <cheie.pem>
 *   ronor-executor issue-mandate <mission_id> <ttl_min> <observe|actuate> < obiectiv.txt
 *   ronor-executor action-hash  < cerere.json   # hash-ul pe care îl aprobă omul
 *   ronor-executor approve <ttl_sec> [origine] < cerere.json
 *
 * Configurația vine din mediu:
 *   - executorul: RONOR_EXECUTOR_CATALOG, RONOR_EXECUTOR_DB,
 *     RONOR_EXECUTOR_STOP_FILE (opțional), RONOR_EXECUTOR_MANDATE_PUBKEYS_FILE și
 *     RONOR_EXECUTOR_APPROVER_PUBKEYS_FILE (numai chei publice Ed25519),
 *     RONOR_EXECUTOR_RECEIPT_KEY_FILE (cheia privată proprie, pentru chitanțe);
 *   - omul: RONOR_EXECUTOR_CATALOG (pentru hash și gazdă),
 *     RONOR_MANDATE_ISSUER_KEY_FILE, respectiv RONOR_APPROVER_KEY_FILE.
 * Nicio cheie nu se primește în argumente sau în cerere și niciuna nu se afișează.
 */
import fs from 'node:fs';
import { actionHash, REQUEST_ORIGINS, signActuationApproval, type RequestOrigin } from './approval';
import { parseExecutorCatalog, planAction } from './catalog';
import { issueOperationsMandate, MandatedExecutor, type ExecutionRequest } from './executor';
import { ExecutorJournal } from './journal';
import { generateSigningKeyPair, keyId, parsePrivateKey, parsePublicKeyring } from './keys';
import crypto from 'node:crypto';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function readFile(name: string): string {
  return fs.readFileSync(required(name), 'utf8');
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8');
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function loadCatalog() {
  return parseExecutorCatalog(JSON.parse(readFile('RONOR_EXECUTOR_CATALOG')));
}

export const OPERATOR_COMMANDS = ['keygen', 'key-id', 'issue-mandate', 'action-hash', 'approve'] as const;
export const EXECUTOR_COMMANDS = ['status', 'stop', 'clear-stop', 'revoke-mandate', 'revoke-approval', 'execute'] as const;

/** Comenzile omului: fără jurnal, fără cheile executorului. */
function operatorCommand(command: string, rest: string[]): number {
  if (command === 'keygen') {
    const [privatePath, publicPath] = rest;
    if (!privatePath || !publicPath) throw new Error('keygen_requires_two_paths');
    const pair = generateSigningKeyPair();
    // `wx`: nu suprascrie o cheie existentă.
    fs.writeFileSync(privatePath, pair.privatePem, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(publicPath, pair.publicPem, { mode: 0o644, flag: 'wx' });
    print({ key_id: pair.keyId, public_key_file: publicPath });
    return 0;
  }
  if (command === 'key-id') {
    const pem = fs.readFileSync(rest[0], 'utf8');
    const key = /PRIVATE KEY/.test(pem) ? parsePrivateKey(pem, 'key') : crypto.createPublicKey(pem);
    print({ key_id: keyId(key) });
    return 0;
  }
  const catalog = loadCatalog();
  if (command === 'issue-mandate') {
    const [missionId, ttl, scope] = rest;
    if (scope !== 'observe' && scope !== 'actuate') throw new Error('issue_mandate_scope_must_be_observe_or_actuate');
    const issuer = parsePrivateKey(readFile('RONOR_MANDATE_ISSUER_KEY_FILE'), 'mandate_issuer');
    print(issueOperationsMandate({ missionId, objective: readStdin().trim(), hostId: catalog.host_id, allowActuate: scope === 'actuate', ttlMinutes: Number(ttl) }, issuer));
    return 0;
  }
  const request = JSON.parse(readStdin()) as ExecutionRequest;
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
  const [ttl, origin] = rest;
  if (origin !== undefined && !REQUEST_ORIGINS.includes(origin as RequestOrigin)) throw new Error('approval_origin_invalid');
  const approver = parsePrivateKey(readFile('RONOR_APPROVER_KEY_FILE'), 'approver');
  print(signActuationApproval({ mandateId: request.mandate.mandate_id, actionHash: hash, ttlMs: Number(ttl) * 1000, origin: origin as RequestOrigin | undefined }, approver));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if ((OPERATOR_COMMANDS as readonly string[]).includes(command)) return operatorCommand(command, rest);
  if (!(EXECUTOR_COMMANDS as readonly string[]).includes(command)) {
    process.stderr.write(`comenzi: ${[...EXECUTOR_COMMANDS, ...OPERATOR_COMMANDS].join(' | ')}\n`);
    return 64;
  }
  const catalog = loadCatalog();
  const mandateKeys = parsePublicKeyring(readFile('RONOR_EXECUTOR_MANDATE_PUBKEYS_FILE'), 'mandate');
  const approvalKeys = parsePublicKeyring(readFile('RONOR_EXECUTOR_APPROVER_PUBKEYS_FILE'), 'approval');
  const receiptKey = parsePrivateKey(readFile('RONOR_EXECUTOR_RECEIPT_KEY_FILE'), 'receipt');
  const journal = new ExecutorJournal(required('RONOR_EXECUTOR_DB'));
  try {
    const executor = MandatedExecutor.create({
      catalog,
      journal,
      mandateKeys,
      approvalKeys,
      receiptKey,
      stopFile: process.env.RONOR_EXECUTOR_STOP_FILE,
    });
    switch (command) {
      case 'status':
        print({ ...executor.status(), receipt_key_id: keyId(receiptKey) });
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
      default: {
        const outcome = await executor.execute(JSON.parse(readStdin()) as ExecutionRequest);
        print(outcome);
        return outcome.state === 'done' ? 0 : 1;
      }
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
