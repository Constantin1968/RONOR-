/**
 * Shared primitives for the automation services.
 *
 * 1. `bearerMatches` compares a presented `Authorization` header with a service
 *    token in constant time. A plain `===` on a credential returns as soon as the
 *    first differing character is reached, so response timing reveals how much of
 *    the prefix was right. Both sides are reduced to SHA-256 digests first, which
 *    gives equal-length buffers for `timingSafeEqual` and removes the length
 *    signal as well. An empty configured token never matches.
 *
 * 2. `readRegularFileNoFollow` opens a path once, with `O_NOFOLLOW`, and makes
 *    every assertion on the descriptor that is then read. Checking a path with
 *    `lstat` and reading it again by name leaves a window in which the name can
 *    be pointed at a different object; reading through the checked descriptor
 *    closes that window.
 */
import crypto from 'crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'fs';

const digest = (value: string): Buffer => crypto.createHash('sha256').update(value, 'utf8').digest();

export function bearerMatches(header: string | undefined, token: string | undefined): boolean {
  if (!token) return false;
  const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
  if (!match) return false;
  return crypto.timingSafeEqual(digest(match[1]), digest(token));
}

export function readRegularFileNoFollow(target: string, maxBytes?: number): Buffer {
  const descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error('not_a_regular_file');
    if (maxBytes !== undefined && metadata.size > maxBytes) throw new Error('file_too_large');
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
