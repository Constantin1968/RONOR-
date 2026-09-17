import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { OpenHandsExecutionEnvelope } from '../contracts';

const MAX_BYTES = 4096;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safeId = (value: unknown): value is string => typeof value === 'string' &&
  value.length >= 1 && value.length <= 120 && /^[A-Za-z0-9]/.test(value) && !/[^A-Za-z0-9._-]/.test(value);

interface ReceiptIdentity {
  schema_version: 1;
  conversation_id: string;
  run_id: string;
  mission_id: string;
  assignment_id: string;
  objective_hash: string;
}

// Metadata extraction only, NOT authentication. The bridge must have verified
// the signed budget and its binding to this envelope before calling native.execute.
// Keep this decoder private so it cannot become an alternative authorization API.
function receiptIdentity(conversationId: string, envelope: OpenHandsExecutionEnvelope): ReceiptIdentity {
  try {
    if (typeof conversationId !== 'string' || conversationId.length !== 36 || !UUID.test(conversationId) ||
        !envelope || !safeId(envelope.assignment_id) ||
        typeof envelope.objective_hash !== 'string' || envelope.objective_hash.length !== 64 ||
        !/^[a-f0-9]{64}$/.test(envelope.objective_hash)) throw new Error();
    const token = envelope.budget_token;
    if (typeof token !== 'string' || token.length > MAX_BYTES ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
    const [payload, signature] = token.split('.');
    const decoded = Buffer.from(payload, 'base64url');
    if (decoded.toString('base64url') !== payload ||
        Buffer.from(signature, 'base64url').toString('base64url') !== signature) throw new Error();
    const claims: unknown = JSON.parse(decoded.toString('utf8'));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error();
    const value = claims as Record<string, unknown>;
    if (value.audience !== 'ronor-model-egress/v1' || value.role !== 'author' ||
        !safeId(value.budget_id) || !safeId(value.mission_id)) throw new Error();
    return {
      schema_version: 1, conversation_id: conversationId.toLowerCase(), run_id: value.budget_id,
      mission_id: value.mission_id, assignment_id: envelope.assignment_id, objective_hash: envelope.objective_hash,
    };
  } catch {
    throw new Error('openhands_conversation_receipt_claims_invalid');
  }
}

function assertDirectoryTree(directory: string): void {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error();
  }
}

function assertSameEntry(filename: string, descriptor: number): void {
  const entry = lstatSync(filename);
  const opened = fstatSync(descriptor);
  if (entry.isSymbolicLink() || entry.dev !== opened.dev || entry.ino !== opened.ino) throw new Error();
}

function openDirectory(directory: string): number {
  assertDirectoryTree(directory);
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    // These service-owned directories must not admit writes from other users.
    // The mode is read from the open descriptor, not from the path: a check on
    // the path proves a property of whatever the name resolved to at that
    // instant, and the entry can be replaced before the open. Only the
    // descriptor is the object actually used afterwards, so it is the only one
    // worth asserting about. assertSameEntry pins name to descriptor, but both
    // sides would see a substituted entry, so it cannot recover this mode.
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || (opened.mode & 0o022) !== 0) throw new Error();
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function readExisting(descriptor: number, identity: ReceiptIdentity): void {
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
    if (count === 0) break;
    bytes += count;
  }
  if (bytes === 0 || bytes > MAX_BYTES) throw new Error();
  const stored: unknown = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error();
  const receipt = stored as Record<string, unknown>;
  const keys = [...Object.keys(identity), 'created_at'];
  if (Object.keys(receipt).length !== keys.length || Object.keys(receipt).some(key => !keys.includes(key)) ||
      Object.entries(identity).some(([key, value]) => receipt[key] !== value) ||
      typeof receipt.created_at !== 'string' || receipt.created_at.length !== 24 ||
      new Date(receipt.created_at).toISOString() !== receipt.created_at) throw new Error();
}

function persistReceipt(directory: string, identity: ReceiptIdentity): void {
  const parent = path.dirname(directory);
  let parentDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let descriptor: number | undefined;
  try {
    // Only the final conversations directory may be created; its nonce-store
    // parent must already exist. Recheck the tree on every call, not just startup.
    parentDescriptor = openDirectory(parent);
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    directoryDescriptor = openDirectory(directory);
    assertSameEntry(parent, parentDescriptor);
    assertSameEntry(directory, directoryDescriptor);
    const filename = path.join(directory, `${identity.conversation_id}.json`);
    let existing = false;
    try {
      // wx (O_EXCL) refuses existing entries, including dangling symlinks.
      descriptor = openSync(filename, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      existing = true;
      descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    }
    assertSameEntry(filename, descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) throw new Error();
    if (existing) {
      readExisting(descriptor, identity);
    } else {
      const receipt = JSON.stringify({ ...identity, created_at: new Date().toISOString() }) + '\n';
      if (Buffer.byteLength(receipt) > MAX_BYTES) throw new Error();
      writeFileSync(descriptor, receipt, { encoding: 'utf8' });
    }
    // Success is not reported until both data and directory entries are durable.
    // A crash/partial write is never "repaired" by overwriting a prior receipt:
    // incomplete or conflicting files remain fail-closed for operator review.
    fsyncSync(descriptor);
    assertDirectoryTree(directory);
    assertSameEntry(filename, descriptor);
    assertSameEntry(directory, directoryDescriptor);
    assertSameEntry(parent, parentDescriptor);
    fsyncSync(directoryDescriptor);
    fsyncSync(parentDescriptor);
  } finally {
    let closeFailed = false;
    for (const fd of [descriptor, directoryDescriptor, parentDescriptor]) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { closeFailed = true; }
      }
    }
    if (closeFailed) throw new Error();
  }
}

/** Durable identity receipts, not acceptance evidence or a replacement for the
 * bridge's authentication. This factory has no startup filesystem side effects. */
export function createConversationRecorder(directory: string):
  (conversationId: string, envelope: OpenHandsExecutionEnvelope) => Promise<void> {
  if (typeof directory !== 'string' || !directory || directory.length > MAX_BYTES || directory.includes('\0')) {
    throw new Error('openhands_conversation_receipt_unavailable');
  }
  const root = path.resolve(directory);
  return async (conversationId, envelope) => {
    const identity = receiptIdentity(conversationId, envelope);
    try { persistReceipt(root, identity); }
    catch { throw new Error('openhands_conversation_receipt_unavailable'); }
  };
}
