import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import type { EvidenceArtifact } from './contracts';

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export interface WorkspaceArtifactCollector {
  collect(workspaceRoot: string, runId: string, assignmentId: string): EvidenceArtifact[];
}

function digest(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function git(workspaceRoot: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', workspaceRoot, ...args], {
    encoding: 'buffer', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_ARTIFACT_BYTES,
  });
}

function boundedContent(content: Buffer): Buffer {
  if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error('artifact_too_large');
  return content;
}

function assertNoSecretMaterial(content: Buffer): void {
  const text = content.toString('utf8');
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i,
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*['"]?[A-Za-z0-9._~+/-]{16,}/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw new Error('artifact_secret_material_refused');
}

export function createWorkspaceArtifactCollector(artifactRoot: string): WorkspaceArtifactCollector {
  const requestedRoot = path.resolve(artifactRoot);
  if (lstatSync(requestedRoot).isSymbolicLink()) throw new Error('artifact_root_link_refused');
  const canonicalRoot = realpathSync.native(requestedRoot);

  const persist = (runId: string, assignmentId: string, name: string, kind: EvidenceArtifact['kind'], content: Buffer): EvidenceArtifact => {
    if (!SAFE_ID.test(runId) || !SAFE_ID.test(assignmentId)) throw new Error('artifact_identifier_invalid');
    const directory = path.join(canonicalRoot, runId, assignmentId);
    mkdirSync(directory, { recursive: true });
    const canonicalDirectory = realpathSync.native(directory);
    const relativeDirectory = path.relative(canonicalRoot, canonicalDirectory);
    if (relativeDirectory.startsWith('..') || path.isAbsolute(relativeDirectory)) throw new Error('artifact_path_escape');
    const destination = path.join(canonicalDirectory, name);
    const value = boundedContent(content);
    assertNoSecretMaterial(value);
    const sha256 = digest(value);
    if (existsSync(destination)) {
      if (digest(readFileSync(destination)) !== sha256) throw new Error('artifact_collision');
    } else {
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      try { writeFileSync(temporary, value, { flag: 'wx' }); renameSync(temporary, destination); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
    }
    return { kind, sha256, reference: path.relative(canonicalRoot, destination).split(path.sep).join('/'), bytes: value.byteLength };
  };

  return {
    collect(workspaceRoot, runId, assignmentId) {
      const workspace = realpathSync.native(path.resolve(workspaceRoot));
      const top = realpathSync.native(execFileSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true }).trim());
      if (workspace !== top) throw new Error('artifact_workspace_not_git_root');
      const diff = git(workspace, ['diff', '--binary', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/']);
      const status = git(workspace, ['status', '--porcelain=v1', '--untracked-files=all']);
      return [
        persist(runId, assignmentId, 'git.diff', 'git_diff', diff),
        persist(runId, assignmentId, 'git.status', 'git_status', status),
      ];
    },
  };
}
