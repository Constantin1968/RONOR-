#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Commands, printed on request. Kept beside the dispatch below so the two
 * cannot drift apart: every key here must be accepted by main(). */
export const COMMANDS = {
  'readiness': 'Întreabă controlerul dacă automatizarea este pregătită. Nu pornește nimic.',
  'start': '--request=<fișier> --id=<identificator-stabil> — pregătește o misiune și pornește autorul.',
  'status': '--mission=<misiune> --run=<rulare> — starea unei rulări de autor.',
  'cancel': '--mission=<misiune> --run=<rulare> — cere anularea unei rulări de autor.',
  'verify-existing': '--request=<fișier> --id=<identificator-stabil> — verifică un commit deja existent, fixat, fără autor.',
  'verification-status': '--verification=verify_<64 hex> — starea unei verificări de commit existent.',
  'verification-cancel': '--verification=verify_<64 hex> — cere anularea unei verificări de commit existent.',
};

export function usageText() {
  return [
    'ronor-develop — interfața arhitectului către controlerul de dezvoltare (numai bucla locală).',
    '',
    'Comenzi:',
    ...Object.entries(COMMANDS).map(([name, help]) => `  ${name.padEnd(20)}${help}`),
    '  help                Afișează acest text.',
    '',
    'Mediu obligatoriu:',
    '  RONOR_DEVELOPMENT_API_KEY_FILE  fișier cu cheia arhitectului, mod 600, cel mult 4096 octeți.',
    '  RONOR_DEVELOPMENT_URL           opțional; trebuie să fie bucla locală.',
    '',
    'Contractul cererii pentru verify-existing: base_commit, head_commit (40 hex, distincte),',
    'max_cost_usd (cel mult 5), max_runtime_minutes (1–60). Orice altă cheie este refuzată.',
  ];
}

/** Closed set of refusal codes. Only a code present here is ever shown, so a
 * compromised or confused controller cannot push arbitrary text or a secret
 * into the operator's terminal. */
export const EXPLANATIONS = {
  invalid_command: 'Comandă necunoscută. Rulează „help” pentru lista comenzilor.',
  invalid_option: 'Opțiune necunoscută sau prost formată. Folosește forma --nume=valoare.',
  controller_requires_loopback: 'Adresa controlerului trebuie să fie bucla locală, fără acreditări în URL.',
  credential_file_required: 'Lipsește RONOR_DEVELOPMENT_API_KEY_FILE.',
  credential_file_permissions_refused: 'Fișierul cu cheia trebuie să fie un fișier obișnuit, mod 600, cel mult 4096 octeți.',
  credential_too_short: 'Cheia arhitectului este prea scurtă.',
  stable_id_and_request_required: 'Sunt necesare --id (identificator stabil) și --request (fișier de cerere).',
  request_file_refused: 'Fișierul de cerere a fost refuzat: trebuie fișier obișnuit, nu legătură simbolică, sub limita de mărime.',
  request_contract_refused: 'Cererea nu respectă contractul. Verifică cheile permise și plafoanele.',
  verification_id_required: 'Este necesar --verification=verify_<64 hex>.',
  run_and_mission_required: 'Sunt necesare --mission și --run.',
  automation_not_ready: 'Automatizarea nu este pregătită; nu s-a trimis nicio intenție și nu s-a pornit nimic.',
  verification_disabled: 'Verificarea commit-urilor existente este dezactivată pe această gazdă.',
  verification_requires_recovery_disabled: 'Politica de mandat cere ca reluarea după cădere să fie dezactivată înainte de verificare.',
  verification_configuration_missing: 'Configurația de verificare lipsește pe gazdă.',
  verification_identity_refused: 'O autoritate nu și-a dovedit identitatea așteptată; verificarea a fost refuzată.',
  verification_endpoint_refused: 'O autoritate nu a răspuns la punctul său de intrare așteptat.',
  verification_authority_unavailable: 'O autoritate necesară este indisponibilă.',
  verification_authority_refused: 'Cheia folosită nu are autoritatea de arhitect pentru această operațiune.',
  verification_identifier_invalid: 'Identificatorul verificării nu are forma cerută.',
  verification_request_invalid: 'Cererea de verificare este invalidă.',
  verification_budget_refused: 'Plafonul de cost cerut nu este admis de politica de buget.',
  verification_idempotency_conflict: 'Același identificator stabil a fost folosit deja pentru altă cerere.',
  verification_head_mismatch: 'Candidatul cerut nu este cel fixat de politica de mandat pe această gazdă.',
  verification_workspace_busy: 'Spațiul de lucru este deja angajat de o altă verificare sau de o rulare de automatizare. Dacă cea anterioară s-a încheiat deja, prin anulare sau întrerupere, controlerul întreabă acum executantul de probe și registrul de decontare dacă a mai rămas ceva în execuție; când amândouă confirmă liniștea, bariera se eliberează fără să aștepte termenul mandatului, iar cererea următoare este admisă. Cât timp o probă mai rulează în arbore sau o trimitere către model este nedecontată, refuzul se menține până la acel termen.',
  verification_not_found: 'Nu există nicio verificare cu acest identificator.',
  verification_integrity_failed: 'Integritatea stării sau a probelor nu a putut fi confirmată; verificarea a eșuat închis.',
  verification_pins_invalid: 'Commit-urile fixate sunt invalide sau candidatul nu descinde din bază.',
  verification_workspace_refused: 'Arborele de lucru nu a fost acceptat: trebuie curat și fixat pe candidat.',
  verification_workspace_dirty: 'Arborele de lucru are modificări necomise sau fișiere neurmărite; verificarea cere un arbore curat.',
  verification_workspace_timeout: 'Inspecția arborelui de lucru a depășit termenul acordat.',
  verification_empty_range_refused: 'Intervalul dintre bază și candidat este gol.',
  verification_deadline_exceeded: 'Termenul acordat a fost depășit; verificarea a fost închisă.',
  verification_restart_interrupted: 'Verificarea a fost întreruptă de o repornire și, prin proiectare, nu se reia singură.',
  verification_shutdown_interrupted: 'Verificarea a fost întreruptă de oprirea serviciului și nu se reia singură.',
  verification_cancelled: 'Verificarea a fost anulată la cerere.',
  verification_codex_refused: 'Codex nu a emis o chitanță acceptabilă.',
  verification_victoria_refused: 'Asigurarea Victoria nu a acceptat politica.',
  verification_interrupted: 'Starea sau politica s-a schimbat sub verificare; a fost închisă fără reluare automată.',
  verification_workspace_changed: 'Arborele de lucru s-a schimbat în timpul verificării; rezultatul nu mai corespunde diferenței examinate.',
  verification_evidence_invalid: 'Probele returnate nu respectă schema așteptată.',
  verification_range_mismatch: 'Probele nu corespund intervalului fixat dintre bază și candidat.',
  verification_tests_invalid: 'Raportul de teste nu respectă schema așteptată sau nu confirmă o trecere.',
  authority_http_refused: 'O autoritate a răspuns cu o stare neacceptabilă.',
  authority_identity_refused: 'O autoritate nu și-a dovedit identitatea așteptată.',
  existing_verification_refused: 'Operațiunea de verificare a fost refuzată.',
  invalid_development_job: 'Cererea de lucrare de dezvoltare este invalidă.',
  invalid_reconciliation_request: 'Cererea de reconciliere este invalidă.',
  legacy_reconciliation_refused: 'Reconcilierea unei căderi vechi de autor a fost refuzată.',
  not_found: 'Ruta cerută nu există pe controler.',
};

export class ControllerRefusal extends Error {
  constructor(code, httpStatus) { super(code); this.code = code; this.httpStatus = httpStatus; }
}

const known = code => typeof code === 'string' && Object.prototype.hasOwnProperty.call(EXPLANATIONS, code);

/** Never returns anything but text this file authored. */
export function failureLine(error) {
  const tail = 'Nu a fost retrimisă automat; păstrează același identificator pentru verificare.';
  if (error instanceof ControllerRefusal && known(error.code)) {
    return `Refuz al controlerului: ${error.code} (HTTP ${error.httpStatus}). ${EXPLANATIONS[error.code]} ${tail}`;
  }
  const message = error && typeof error.message === 'string' ? error.message : '';
  if (known(message)) return `Cerere refuzată: ${message}. ${EXPLANATIONS[message]} ${tail}`;
  const http = /^controller_http_([1-5][0-9][0-9])$/.exec(message);
  if (http) return `Controlerul a răspuns cu starea ${http[1]}, fără un cod de refuz recunoscut. ${tail}`;
  return `Comanda nu a reușit. ${tail}`;
}

// A file is opened once and then asserted about on its own descriptor. Checking
// a path and reopening it leaves a window in which the name can be pointed at a
// different object, so the thing verified is not the thing read. O_NOFOLLOW
// refuses a symbolic link at the final component outright, and nlink === 1
// refuses a hard link placed to alias a file the operator did not name.
function openVerified(file, maxBytes, modeMask) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes ||
        (modeMask !== undefined && (stat.mode & modeMask))) {
      return { descriptor: undefined, refuse: true };
    }
    return { descriptor, refuse: false };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function readCredential(file) {
  let opened;
  try { opened = openVerified(file, 4096, 0o077); }
  catch { throw new Error('credential_file_permissions_refused'); }
  if (opened.refuse) throw new Error("credential_file_permissions_refused");
  try { return fs.readFileSync(opened.descriptor, 'utf8').trim(); }
  finally { fs.closeSync(opened.descriptor); }
}

export function readBoundedFile(file, maxBytes) {
  let opened;
  try { opened = openVerified(file, maxBytes, undefined); }
  catch { throw new Error('request_file_refused'); }
  if (opened.refuse) throw new Error('request_file_refused');
  try { return fs.readFileSync(opened.descriptor, 'utf8'); }
  finally { fs.closeSync(opened.descriptor); }
}

export function controllerUrl(value = 'http://127.0.0.1:3010') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('controller_requires_loopback');
  }
  return url.origin;
}

export async function developmentRequest(base, key, route, method = 'GET', body, idempotencyKey) {
  const response = await fetch(`${base}${route}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    // Surface the controller's own refusal code, but only when it belongs to the
    // closed set above; anything else degrades to the bare status.
    let code;
    try {
      const body = await response.json();
      if (body && typeof body === 'object' && known(body.error)) code = body.error;
    } catch { /* a body that is absent or not JSON tells us nothing safe */ }
    if (code) throw new ControllerRefusal(code, response.status);
    throw new Error(`controller_http_${response.status}`);
  }
  return response.json();
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const [command, ...rest] = args;
  // Help must never touch a credential, a file or the network.
  if (command === undefined || ['help', '--help', '-h'].includes(command)) return { usage: usageText() };
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) throw new Error('invalid_command');
  const options = Object.fromEntries(rest.map(item => {
    const separator = item.indexOf('=');
    if (separator < 3 || !item.startsWith('--')) throw new Error('invalid_option');
    return [item.slice(2, separator), item.slice(separator + 1)];
  }));
  if (Object.keys(options).some(key => !['request', 'id', 'mission', 'run', 'verification'].includes(key))) throw new Error('invalid_option');
  const base = controllerUrl(env.RONOR_DEVELOPMENT_URL);
  const file = env.RONOR_DEVELOPMENT_API_KEY_FILE;
  if (!file) throw new Error('credential_file_required');
  // The credential is read through one descriptor that is opened first and then
  // asserted about, never through a path that is checked and reopened. This file
  // becomes a bearer token on the wire, so a name swapped between a check and a
  // read would send the contents of a file the operator never authorised. Only
  // the opened object can be trusted, so every assertion is made on it.
  const key = readCredential(file);
  if (Buffer.byteLength(key) < 32) throw new Error('credential_too_short');
  const request = (route, method, body, id) => developmentRequest(base, key, route, method, body, id);
  if (command === 'verify-existing') {
    if (Object.keys(options).some(k => !['request', 'id'].includes(k)) ||
        !/^[A-Za-z0-9_-]{8,120}$/.test(options.id || '') || !options.request)
      throw new Error('stable_id_and_request_required');
    const spec = JSON.parse(readBoundedFile(options.request, 4096));
    if (!spec || typeof spec !== 'object' || Array.isArray(spec) ||
        Object.keys(spec).some(k => !['base_commit', 'head_commit', 'max_cost_usd', 'max_runtime_minutes'].includes(k)) ||
        !/^[a-f0-9]{40}$/.test(spec.base_commit || '') || !/^[a-f0-9]{40}$/.test(spec.head_commit || '') ||
        spec.base_commit === spec.head_commit || !Number.isFinite(spec.max_cost_usd) || spec.max_cost_usd <= 0 ||
        spec.max_cost_usd > 5 || !Number.isInteger(spec.max_runtime_minutes) ||
        spec.max_runtime_minutes < 1 || spec.max_runtime_minutes > 60) throw new Error('request_contract_refused');
    // Dedicated controller admission attests only evidence/Codex/Victoria.
    // Do not call five-party development readiness, prepare a mission, or start an author.
    const result = await request('/api/development/verify-existing', 'POST', { approved: true, ...spec }, options.id);
    return { verification: result.verification };
  }
  if (command === 'verification-status' || command === 'verification-cancel') {
    if (Object.keys(options).some(k => k !== 'verification') ||
        !/^verify_[a-f0-9]{64}$/.test(options.verification || '')) throw new Error('verification_id_required');
    const route = `/api/development/verifications/${options.verification}`;
    const result = command === 'verification-cancel'
      ? await request(`${route}/cancel`, 'POST', {})
      : await request(route);
    const record = result.verification;
    // A refusal reason is only explained when it is one this file knows.
    const explained = record && known(record.reason) ? { reason_explained: EXPLANATIONS[record.reason] } : {};
    // A run that ended without reporting a cost still spent money. When the
    // egress ledger was read, say plainly that this figure is observed, that it
    // is a floor while dispatches remain unresolved, and that it is not an invoice.
    const observed = record && record.cost_usd === null && record.observed_cost_usd !== null &&
      record.observed_cost_usd !== undefined
      ? { cost_observed_explained: `Costul raportat lipseste. Registrul de iesire arata ${record.observed_cost_usd} USD decontati efectiv` +
          (record.observed_unresolved_dispatches
            ? `, plus ${record.observed_unresolved_dispatches} cerere(ri) cu rezultat neconfirmat, deci cifra este un prag minim.`
            : '.') +
          ' Baza este tariful de catalog aplicat contoarelor furnizorului, nu o factura.' }
      : {};
    return { verification: record, ...explained, ...observed,
      ...(command === 'verification-cancel' ? { rollback: false } : {}) };
  }
  if (command === 'readiness') {
    const result = await request('/api/runtime/control/automation/readiness');
    return { ready: result.ok === true && result.automation?.ready === true };
  }
  if (command === 'start') {
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(options.id || '') || !options.request) throw new Error('stable_id_and_request_required');
    const spec = JSON.parse(readBoundedFile(options.request, 16000));
    if (Object.keys(spec).some(key => !['objective', 'max_cost_usd', 'max_runtime_minutes', 'max_fix_cycles'].includes(key)) ||
        typeof spec.objective !== 'string' || spec.objective.length < 1 || spec.objective.length > 8000 ||
        !Number.isFinite(spec.max_cost_usd) || spec.max_cost_usd <= 0 ||
        !Number.isInteger(spec.max_runtime_minutes) || spec.max_runtime_minutes <= 0 ||
        !Number.isInteger(spec.max_fix_cycles) || spec.max_fix_cycles < 0) throw new Error('request_contract_refused');
    const readiness = await request('/api/runtime/control/automation/readiness');
    if (readiness.ok !== true || readiness.automation?.ready !== true) throw new Error('automation_not_ready');
    const prepared = await request('/api/development/jobs', 'POST', { objective: spec.objective }, options.id);
    const result = await request('/api/runtime/control/automation/run', 'POST', {
      approved: true, mission_id: prepared.job.mission_id,
      max_cost_usd: spec.max_cost_usd, max_runtime_minutes: spec.max_runtime_minutes,
      max_fix_cycles: spec.max_fix_cycles,
    }, options.id);
    return { job_id: prepared.job.job_id, mission_id: prepared.job.mission_id,
      run_id: result.run.run_id, status: result.run.status };
  }
  if (![options.run, options.mission].every(id => /^[A-Za-z0-9_-]{1,120}$/.test(id || ''))) {
    throw new Error('run_and_mission_required');
  }
  const route = `/api/runtime/control/automation/runs/${options.run}`;
  if (command === 'cancel') {
    const result = await request(`${route}/cancel`, 'POST', { mission_id: options.mission });
    return { status: result.status, rollback: false };
  }
  const result = await request(`${route}?mission_id=${options.mission}`);
  return { run: result.run, progress: result.fabric_run };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(value => console.log(value.usage ? value.usage.join('\n') : JSON.stringify(value))).catch(error => {
    // Keys, objectives, paths and arbitrary server messages must never reach stderr.
    console.error(failureLine(error));
    process.exitCode = 1;
  });
}
