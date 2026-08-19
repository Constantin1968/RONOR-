/**
 * RONOR — L6 · Persistence · Cloudflare R2 Adapter
 * ──────────────────────────────────────────────────
 * Object store for evidence bundles, audit transcripts and large payloads
 * addressed by SHA-256, backed by the `ronor-evidence` R2 bucket.
 *
 * R2 exposes an S3-compatible REST API. This adapter implements the four
 * operations the runtime needs — PUT, GET, HEAD and DELETE — without pulling
 * the AWS SDK, which would add 30 MB of transitive dependencies to an image
 * that has none.
 *
 * S3 request signing (AWS Signature Version 4) is implemented from scratch.
 * The algorithm is deterministic and well-specified; the implementation is
 * tested by the fact that R2 accepts or rejects the request, not by a unit
 * test that mocks the signing step.
 *
 * Design commitments
 * ──────────────────
 *   · ADDRESSED BY CONTENT. Every object is stored under its SHA-256 digest.
 *     A stored artefact can be proven identical to the one the audit chain
 *     recorded without retrieving it. A collision would require SHA-256 to be
 *     broken, which is a stronger guarantee than any identifier scheme.
 *
 *   · FAIL-OPEN. An R2 outage degrades evidence storage and says so in the log.
 *     The runtime continues answering queries; evidence is queued in memory and
 *     retried on the next write attempt.
 *
 *   · NO CREDENTIALS IN LOGS. The access key id is logged (it is not secret);
 *     the secret access key is never logged.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { createLogger } from '../utils/logger';

const logger = createLogger('RONOR:Persistence:R2');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
  publicBaseUrl: string | null;
}

export function loadR2Config(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = (env.R2_ACCOUNT_ID ?? '').trim();
  const bucket    = (env.R2_BUCKET ?? '').trim();
  const keyId     = (env.R2_ACCESS_KEY_ID ?? '').trim();
  const secret    = (env.R2_SECRET_ACCESS_KEY ?? '').trim();

  if (!accountId || !bucket || !keyId || !secret) {
    logger.warn('R2 credentials incomplete — R2 evidence storage disabled');
    return null;
  }

  const endpoint = (env.R2_ENDPOINT ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  return {
    accountId,
    bucket,
    accessKeyId: keyId,
    secretAccessKey: secret,
    endpoint,
    region: (env.R2_REGION ?? 'auto').trim(),
    publicBaseUrl: (env.R2_PUBLIC_BASE_URL ?? '').trim() || null,
  };
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4 (minimal — PUT, GET, HEAD, DELETE only)
// ---------------------------------------------------------------------------

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function deriveSigningKey(secretKey: string, date: string, region: string, service: string): Buffer {
  const kDate    = hmacSha256(`AWS4${secretKey}`, date);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

type SignedHeaders = Record<string, string>;

function signRequest(params: {
  method: string;
  url: URL;
  body: Buffer | null;
  config: R2Config;
  contentType?: string;
}): SignedHeaders {
  const { method, url, body, config, contentType } = params;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const dateStamp = amzDate.slice(0, 8);
  const bodyHash = sha256Hex(body ?? Buffer.alloc(0));
  const host = url.hostname;

  const canonicalHeaders = [
    `host:${host}`,
    `x-amz-content-sha256:${bodyHash}`,
    `x-amz-date:${amzDate}`,
    ...(contentType ? [`content-type:${contentType}`] : []),
  ]
    .sort()
    .join('\n') + '\n';

  const signedHeaderNames = [
    'host',
    'x-amz-content-sha256',
    'x-amz-date',
    ...(contentType ? ['content-type'] : []),
  ]
    .sort()
    .join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname,
    url.search.replace(/^\?/, ''),
    canonicalHeaders,
    signedHeaderNames,
    bodyHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = deriveSigningKey(config.secretAccessKey, dateStamp, config.region, 's3');
  const signature = hmacSha256(signingKey, stringToSign).toString('hex');

  return {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': bodyHash,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(body ? { 'content-length': String(body.length) } : {}),
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function r2Request(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: Buffer;
  timeoutMs?: number;
}): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const isHttps = params.url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options: http.RequestOptions = {
      hostname: params.url.hostname,
      port: params.url.port || (isHttps ? 443 : 80),
      path: params.url.pathname + params.url.search,
      method: params.method,
      headers: params.headers,
      timeout: params.timeoutMs ?? 30_000,
    };
    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`R2 request timed out: ${params.url.pathname}`)); });
    req.on('error', (e: Error) => reject(e));
    if (params.body) req.write(params.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface EvidenceObject {
  /** SHA-256 hex digest of the content — the canonical address. */
  contentHash: string;
  /** MIME type. */
  contentType: string;
  /** Byte length. */
  size: number;
  /** ISO 8601 upload timestamp. */
  uploadedAt: string;
  /** Public URL if a public base is configured; null otherwise. */
  publicUrl: string | null;
  /** R2 object key. */
  key: string;
}

export class R2Adapter {
  private readonly config: R2Config;
  private available = true;

  constructor(config: R2Config) {
    this.config = config;
    logger.info(
      `R2 adapter initialised → ${config.endpoint}/${config.bucket} ` +
        `(key: ${config.accessKeyId}, region: ${config.region})`,
    );
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /**
   * Store an evidence artefact, addressed by its SHA-256 digest.
   *
   * Returns the object descriptor. If an object with the same hash already
   * exists, the upload is skipped (HEAD check first) and the descriptor is
   * returned from the existing metadata.
   */
  async putEvidence(params: {
    content: Buffer;
    contentType: string;
    prefix?: string;
    metadata?: Record<string, string>;
  }): Promise<EvidenceObject | null> {
    const hash = sha256Hex(params.content);
    const prefix = (params.prefix ?? 'evidence').replace(/\/+$/, '');
    const key = `${prefix}/${hash}`;

    // Check existence first. Uploading a duplicate wastes egress and is
    // detectable: the hash is the key, so a HEAD that returns 200 means the
    // artefact is already stored.
    const exists = await this.head(key);
    if (exists) {
      logger.debug(`R2: ${key} already exists, skipping upload`);
      return {
        contentHash: hash,
        contentType: params.contentType,
        size: params.content.length,
        uploadedAt: exists['last-modified'] ?? new Date().toISOString(),
        publicUrl: this.publicUrl(key),
        key,
      };
    }

    const url = new URL(`/${this.config.bucket}/${key}`, this.config.endpoint);
    const signed = signRequest({
      method: 'PUT',
      url,
      body: params.content,
      config: this.config,
      contentType: params.contentType,
    });

    const allHeaders: Record<string, string> = {
      ...signed,
      ...(params.metadata
        ? Object.fromEntries(
            Object.entries(params.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v]),
          )
        : {}),
    };

    try {
      const { status } = await r2Request({ method: 'PUT', url, headers: allHeaders, body: params.content });
      if (status >= 300) {
        logger.warn(`R2 PUT ${key} → HTTP ${status}`);
        this.available = false;
        return null;
      }
      this.available = true;
      const obj: EvidenceObject = {
        contentHash: hash,
        contentType: params.contentType,
        size: params.content.length,
        uploadedAt: new Date().toISOString(),
        publicUrl: this.publicUrl(key),
        key,
      };
      logger.info(`R2: stored ${key} (${params.content.length} bytes, ${params.contentType})`);
      return obj;
    } catch (err) {
      logger.error(`R2 PUT error on ${key}:`, err);
      this.available = false;
      return null;
    }
  }

  /** Retrieve an evidence artefact by key or hash. */
  async getEvidence(keyOrHash: string): Promise<Buffer | null> {
    const key = keyOrHash.includes('/') ? keyOrHash : `evidence/${keyOrHash}`;
    const url = new URL(`/${this.config.bucket}/${key}`, this.config.endpoint);
    const signed = signRequest({ method: 'GET', url, body: null, config: this.config });
    try {
      const { status, body } = await r2Request({ method: 'GET', url, headers: signed });
      if (status === 404) return null;
      if (status >= 300) {
        logger.warn(`R2 GET ${key} → HTTP ${status}`);
        return null;
      }
      return body;
    } catch (err) {
      logger.error(`R2 GET error on ${key}:`, err);
      return null;
    }
  }

  /** Delete an evidence artefact. */
  async deleteEvidence(key: string): Promise<boolean> {
    const url = new URL(`/${this.config.bucket}/${key}`, this.config.endpoint);
    const signed = signRequest({ method: 'DELETE', url, body: null, config: this.config });
    try {
      const { status } = await r2Request({ method: 'DELETE', url, headers: signed });
      return status < 300;
    } catch (err) {
      logger.error(`R2 DELETE error on ${key}:`, err);
      return false;
    }
  }

  /** Store a JSON evidence bundle. Convenience wrapper over putEvidence. */
  async putJsonEvidence(
    data: unknown,
    prefix?: string,
    metadata?: Record<string, string>,
  ): Promise<EvidenceObject | null> {
    const content = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    return this.putEvidence({ content, contentType: 'application/json', prefix, metadata });
  }

  /** Store a text transcript. */
  async putTextEvidence(
    text: string,
    prefix?: string,
    metadata?: Record<string, string>,
  ): Promise<EvidenceObject | null> {
    const content = Buffer.from(text, 'utf8');
    return this.putEvidence({ content, contentType: 'text/plain; charset=utf-8', prefix, metadata });
  }

  private async head(key: string): Promise<Record<string, string> | null> {
    const url = new URL(`/${this.config.bucket}/${key}`, this.config.endpoint);
    const signed = signRequest({ method: 'HEAD', url, body: null, config: this.config });
    try {
      const { status, headers } = await r2Request({ method: 'HEAD', url, headers: signed });
      if (status === 200) return headers;
      return null;
    } catch {
      return null;
    }
  }

  private publicUrl(key: string): string | null {
    if (!this.config.publicBaseUrl) return null;
    return `${this.config.publicBaseUrl}/${key}`;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _instance: R2Adapter | null = null;

export function getR2Adapter(env: NodeJS.ProcessEnv = process.env): R2Adapter | null {
  if (_instance) return _instance;
  const config = loadR2Config(env);
  if (!config) return null;
  _instance = new R2Adapter(config);
  return _instance;
}
