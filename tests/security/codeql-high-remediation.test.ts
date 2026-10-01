/**
 * Regression probes for the high-severity CodeQL remediation of 1 October 2026.
 * Each probe fails on the unremediated code and passes on the remediation.
 */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { bearerMatches, readRegularFileNoFollow } from '../../src/runtime/automation/secure-io';
import { stripHtml } from '../../src/runtime/agents/tools';
import { inspectAndValidateWorkspace } from '../../src/runtime/automation/workspace';

describe('bearerMatches (js/user-controlled-bypass #78, #79, #80)', () => {
  const token = 'a'.repeat(48);
  it('accepts the exact bearer token', () => {
    expect(bearerMatches(`Bearer ${token}`, token)).toBe(true);
  });
  it('refuses a wrong, truncated, extended or malformed credential', () => {
    expect(bearerMatches(`Bearer ${'b'.repeat(48)}`, token)).toBe(false);
    expect(bearerMatches(`Bearer ${token.slice(0, 47)}`, token)).toBe(false);
    expect(bearerMatches(`Bearer ${token}x`, token)).toBe(false);
    expect(bearerMatches(token, token)).toBe(false);
    expect(bearerMatches(`Bearer  ${token}`, token)).toBe(false);
    expect(bearerMatches(undefined, token)).toBe(false);
  });
  it('never matches when no service token is configured', () => {
    expect(bearerMatches('Bearer ', '')).toBe(false);
    expect(bearerMatches('Bearer x', '')).toBe(false);
    expect(bearerMatches('Bearer x', undefined)).toBe(false);
  });
});

describe('readRegularFileNoFollow (js/file-system-race #81, #82)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'ronor-secure-io-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('reads a regular file', () => {
    writeFileSync(path.join(dir, 'f'), 'content');
    expect(readRegularFileNoFollow(path.join(dir, 'f')).toString('utf8')).toBe('content');
  });
  it('refuses a final-component symlink at open time', () => {
    writeFileSync(path.join(dir, 'secret'), 'not for you');
    symlinkSync(path.join(dir, 'secret'), path.join(dir, 'link'));
    expect(() => readRegularFileNoFollow(path.join(dir, 'link'))).toThrow();
  });
  it('refuses a directory and an oversized file', () => {
    mkdirSync(path.join(dir, 'd'));
    expect(() => readRegularFileNoFollow(path.join(dir, 'd'))).toThrow('not_a_regular_file');
    writeFileSync(path.join(dir, 'big'), 'x'.repeat(300));
    expect(() => readRegularFileNoFollow(path.join(dir, 'big'), 256)).toThrow('file_too_large');
  });
});

describe('stripHtml (js/bad-tag-filter #16, js/double-escaping #15)', () => {
  it('removes script and style elements whose end tag carries whitespace or junk', () => {
    expect(stripHtml('a<script>alert(1)</script >b')).toBe('a b');
    expect(stripHtml('a<script>alert(1)</script\t\nfoo>b')).toBe('a b');
    expect(stripHtml('a<style>x{}</style >b')).toBe('a b');
  });
  it('decodes an escaped entity exactly once', () => {
    expect(stripHtml('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
    expect(stripHtml('Tom &amp; Jerry &lt;3')).toBe('Tom & Jerry <3');
  });
});

describe('inspectAndValidateWorkspace (js/path-injection #19)', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'ronor-approved-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('refuses a path outside the approved root before resolving it, with the established reason', () => {
    const verdict = inspectAndValidateWorkspace('/etc', {
      approved_root: root, branch_prefix: 'automation/', require_clean: false,
    });
    expect(verdict).toEqual({ valid: false, reason: 'workspace_outside_approved_root' });
  });
  it('refuses a traversal that lexically leaves the approved root', () => {
    const verdict = inspectAndValidateWorkspace(path.join(root, '..', '..', 'etc'), {
      approved_root: root, branch_prefix: 'automation/', require_clean: false,
    });
    expect(verdict.reason).toBe('workspace_outside_approved_root');
  });
  it('still detects a workspace that is itself a link, and admits the real directory', () => {
    const repo = path.join(root, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'automation/probe']);
    execFileSync('git', ['-C', repo, '-c', 'user.name=p', '-c', 'user.email=p@p', 'commit', '-q', '--allow-empty', '-m', 'p']);
    symlinkSync(repo, path.join(root, 'link'));
    const policy = { approved_root: root, branch_prefix: 'automation/', require_clean: false };
    expect(inspectAndValidateWorkspace(path.join(root, 'link'), policy).reason).toBe('workspace_link_refused');
    expect(inspectAndValidateWorkspace(repo, policy)).toMatchObject({ valid: true, reason: null });
  });
});
