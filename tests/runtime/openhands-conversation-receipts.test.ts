import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationRecorder } from '../../src/runtime/automation/services/openhands-conversation-receipts';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const conversationId = 'e643afab-734d-4c24-8e2b-93a1792f2325';
const secret = 'private-receipt-test-material';
const claims = {
  audience: 'ronor-model-egress/v1', role: 'author', budget_id: 'run_0123456789abcdefabcd',
  mission_id: 'msn-receipt', ceiling_micro_usd: 1_000_000, prior_micro_usd: 0,
  expires_at: '2099-01-01T00:00:00.000Z', rate_card: 'dashscope-intl-qwen3.8-max-20260902',
};
function token(value: unknown = claims): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
function envelope(overrides: Partial<OpenHandsExecutionEnvelope> = {}): OpenHandsExecutionEnvelope {
  return {
    assignment_id: 'task-receipt', instruction: `Do not persist this prompt or ${secret}`,
    objective_hash: 'a'.repeat(64), deadline: claims.expires_at, allowed_actions: ['read_repo'],
    budget_token: token(), ...overrides,
  };
}

describe('durable OpenHands conversation receipts', () => {
  let suiteDirectory: string;
  let nonceDirectory: string;
  let directory: string;
  let filename: string;
  beforeAll(() => {
    // Malicious symlink fixtures must never pollute repository-wide snapshots.
    // Keep them in the sandbox temporary directory and remove after the suite.
    suiteDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ronor-conversation-receipts-'));
  });
  afterAll(() => fs.rmSync(suiteDirectory, {recursive:true, force:true}));
  beforeEach(() => {
    nonceDirectory = fs.mkdtempSync(path.join(suiteDirectory, 'case-'));
    directory = path.join(nonceDirectory, 'conversations');
    filename = path.join(directory, `${conversationId}.json`);
  });
  afterEach(() => jest.restoreAllMocks());

  it('writes only bounded identity metadata, with private modes and file/directory fsyncs', async () => {
    const request = envelope({ budget_token: token({ ...claims, secret, prompt: 'private-claim-prompt' }) });
    const syncs: Array<'file' | 'directory'> = [];
    const fsync = fs.fsyncSync;
    jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      syncs.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file');
      fsync(fd);
    });
    const open = jest.spyOn(fs, 'openSync');
    const record = createConversationRecorder(directory);
    expect(fs.existsSync(directory)).toBe(false);
    const before = Date.now();
    await record(conversationId, request);
    const text = fs.readFileSync(filename, 'utf8');
    const receipt = JSON.parse(text);
    expect(receipt).toEqual({
      schema_version: 1, conversation_id: conversationId, run_id: claims.budget_id,
      mission_id: claims.mission_id, assignment_id: request.assignment_id,
      objective_hash: request.objective_hash, created_at: expect.any(String),
    });
    expect(Date.parse(receipt.created_at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(receipt.created_at)).toBeLessThanOrEqual(Date.now());
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(open).toHaveBeenCalledWith(filename, 'wx', 0o600);
    expect(syncs).toEqual(['file', 'directory', 'directory']);
    expect(fs.readdirSync(directory)).toEqual([`${conversationId}.json`]);
    for (const sensitive of [request.budget_token!, request.instruction, secret, 'private-claim-prompt', 'budget_token']) {
      expect(text).not.toContain(sensitive);
    }
  });

  it('reads the same identity idempotently across factories without rewriting its timestamp', async () => {
    await createConversationRecorder(directory)(conversationId, envelope());
    const before = fs.readFileSync(filename, 'utf8');
    const stat = fs.statSync(filename);
    const write = jest.spyOn(fs, 'writeFileSync');
    await Promise.all([
      createConversationRecorder(directory)(conversationId, envelope()),
      createConversationRecorder(directory)(conversationId.toUpperCase(), envelope({
        instruction: 'Another private prompt', budget_token: token({ ...claims, prior_micro_usd: 100 }),
      })),
    ]);
    expect(write).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename, 'utf8')).toBe(before);
    expect(fs.statSync(filename).ino).toBe(stat.ino);
    expect(fs.statSync(filename).mtimeMs).toBe(stat.mtimeMs);
    expect(fs.readdirSync(directory)).toHaveLength(1);
  });

  it('allows concurrent callers to record one immutable identity', async () => {
    await Promise.all(Array.from({ length: 8 }, () => createConversationRecorder(directory)(conversationId, envelope())));
    expect(fs.readdirSync(directory)).toEqual([`${conversationId}.json`]);
    expect(JSON.parse(fs.readFileSync(filename, 'utf8')).conversation_id).toBe(conversationId);
  });

  it.each([
    { budget_token: token({ ...claims, budget_id: 'other-run' }) },
    { budget_token: token({ ...claims, mission_id: 'other-mission' }) },
    { assignment_id: 'other-assignment' },
    { objective_hash: 'b'.repeat(64) },
  ])('refuses a conflicting receipt without overwriting it (case %#)', async overrides => {
    await createConversationRecorder(directory)(conversationId, envelope());
    const before = fs.readFileSync(filename, 'utf8');
    await expect(createConversationRecorder(directory)(conversationId, envelope(overrides)))
      .rejects.toThrow('openhands_conversation_receipt_unavailable');
    expect(fs.readFileSync(filename, 'utf8')).toBe(before);
  });

  it.each([
    undefined, '', 'not-a-token', token().split('.')[0], `${token()}.extra`,
    `${token()}\n`, 'x'.repeat(4097), token(null), token([]), token('claims'),
    token({}), token({ ...claims, audience: 'openhands-bridge' }),
    token({ ...claims, audience: 'ronor-model-egress/v1 ' }), token({ ...claims, role: 'verifier' }),
    token({ ...claims, role: 'AUTHOR' }), token({ ...claims, budget_id: undefined }),
    token({ ...claims, budget_id: '../run' }), token({ ...claims, budget_id: 'a'.repeat(121) }),
    token({ ...claims, budget_id: 'run\n' }), token({ ...claims, budget_id: 42 }),
    token({ ...claims, mission_id: undefined }), token({ ...claims, mission_id: 'msn/escape' }),
    token({ ...claims, mission_id: 'msn\\escape' }), token({ ...claims, mission_id: 'msn\0' }),
    `${Buffer.from('{invalid').toString('base64url')}.${'A'.repeat(43)}`,
    `${token().split('.')[0]}=.${'A'.repeat(43)}`,
  ])('rejects absent, malformed or unauthorized metadata before persistence (case %#)', async budget_token => {
    await expect(createConversationRecorder(directory)(conversationId, envelope({ budget_token })))
      .rejects.toThrow('openhands_conversation_receipt_claims_invalid');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it.each(['../conversation', '------------------------------------', 'e'.repeat(36),
    `${conversationId}\n`, `${conversationId}/events`, 'not-a-uuid'])('refuses unsafe conversation identifiers: %j', async id => {
    await expect(createConversationRecorder(directory)(id, envelope())).rejects.toThrow('receipt_claims_invalid');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it.each([
    { assignment_id: '../task' }, { assignment_id: 'task\n' }, { assignment_id: 'x'.repeat(121) },
    { assignment_id: '' }, { objective_hash: 'not-a-hash' }, { objective_hash: 'A'.repeat(64) },
    { objective_hash: `${'a'.repeat(64)}\n` },
  ])('refuses invalid envelope identity fields: %j', async overrides => {
    await expect(createConversationRecorder(directory)(conversationId, envelope(overrides)))
      .rejects.toThrow('receipt_claims_invalid');
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('fails closed for missing nonce parents rather than recursively creating directories', async () => {
    const missingParent = path.join(nonceDirectory, 'not-configured');
    await expect(createConversationRecorder(path.join(missingParent, 'conversations'))(conversationId, envelope()))
      .rejects.toThrow('receipt_unavailable');
    expect(fs.existsSync(missingParent)).toBe(false);
  });

  it('fails closed when a regular file occupies the receipt directory', async () => {
    fs.writeFileSync(directory, 'keep', { mode: 0o600 });
    await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
    expect(fs.readFileSync(directory, 'utf8')).toBe('keep');
  });

  it.each(['directory', 'ancestor', 'receipt', 'dangling-receipt'])('refuses a symlink at the %s', async kind => {
    const target = path.join(nonceDirectory, 'untouched');
    if (kind === 'directory' || kind === 'ancestor') {
      fs.mkdirSync(target, { mode: 0o700 });
      fs.symlinkSync(target, directory, 'dir');
      const requested = kind === 'ancestor' ? path.join(directory, 'child') : directory;
      await expect(createConversationRecorder(requested)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
      expect(fs.readdirSync(target)).toEqual([]);
    } else {
      fs.mkdirSync(directory, { mode: 0o700 });
      if (kind === 'receipt') fs.writeFileSync(target, 'keep', { mode: 0o600 });
      fs.symlinkSync(target, filename);
      await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
      if (kind === 'receipt') expect(fs.readFileSync(target, 'utf8')).toBe('keep');
      else expect(fs.existsSync(target)).toBe(false);
    }
  });

  it('rechecks the directory after factory creation', async () => {
    const record = createConversationRecorder(directory);
    fs.symlinkSync(nonceDirectory, directory, 'dir');
    await expect(record(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
    expect(fs.existsSync(path.join(nonceDirectory, `${conversationId}.json`))).toBe(false);
  });

  it('rejects hardlinked receipts instead of accepting a writable alias', async () => {
    await createConversationRecorder(directory)(conversationId, envelope());
    fs.linkSync(filename, path.join(nonceDirectory, 'alias.json'));
    await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
  });

  it.each(['', '{', 'x'.repeat(4097)])('refuses empty, partial or oversized existing receipts (case %#)', async content => {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(filename, content, { mode: 0o600 });
    const read = jest.spyOn(fs, 'readSync');
    await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
    if (content.length > 4096) expect(read).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename, 'utf8')).toBe(content);
  });

  it.each([
    { schema_version: 2 }, { conversation_id: '00000000-0000-0000-0000-000000000000' },
    { created_at: 'invalid' }, { created_at: undefined }, { extra: secret },
  ])('refuses malformed or extended receipt schemas (case %#)', async changes => {
    await createConversationRecorder(directory)(conversationId, envelope());
    const changed = JSON.stringify({ ...JSON.parse(fs.readFileSync(filename, 'utf8')), ...changes });
    fs.writeFileSync(filename, changed);
    await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
    expect(fs.readFileSync(filename, 'utf8')).toBe(changed);
  });

  it('rejects broadly readable existing receipts and writable shared directories', async () => {
    await createConversationRecorder(directory)(conversationId, envelope());
    fs.chmodSync(filename, 0o644);
    await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
    fs.chmodSync(filename, 0o600);
    fs.chmodSync(directory, 0o777);
    await expect(createConversationRecorder(directory)(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
  });

  it.each(['write', 'file-sync', 'directory-sync', 'parent-sync'])('propagates %s failures without sensitive diagnostics', async failure => {
    const error = new Error(`filesystem error including ${secret}`);
    const fsync = fs.fsyncSync;
    let syncs = 0;
    if (failure === 'write') jest.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw error; });
    else jest.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      syncs += 1;
      if (syncs === (failure === 'file-sync' ? 1 : failure === 'directory-sync' ? 2 : 3)) throw error;
      fsync(fd);
    });
    const record = createConversationRecorder(directory);
    await expect(record(conversationId, envelope())).rejects.toThrow(/^openhands_conversation_receipt_unavailable$/);
    jest.restoreAllMocks();
    if (failure === 'write') {
      // An interrupted write must not be silently replaced on retry.
      await expect(record(conversationId, envelope())).rejects.toThrow('receipt_unavailable');
    } else {
      // A complete matching receipt may be re-read and synced, never rewritten.
      const before = fs.readFileSync(filename, 'utf8');
      const write = jest.spyOn(fs, 'writeFileSync');
      await record(conversationId, envelope());
      expect(write).not.toHaveBeenCalled();
      expect(fs.readFileSync(filename, 'utf8')).toBe(before);
    }
  });
});
