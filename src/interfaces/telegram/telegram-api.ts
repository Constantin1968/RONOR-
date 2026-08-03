/**
 * RONOR — L0 · Telegram Interface · API Client
 * ─────────────────────────────────────────────
 * A minimal, typed wrapper around the Telegram Bot API. Only the methods this
 * bridge actually calls are implemented; the rest of the surface does not exist
 * here and cannot be accidentally invoked.
 *
 * Retry logic is intentionally absent. A message that fails to send is logged
 * and dropped rather than retried indefinitely. The bridge is a convenience
 * channel for a human operator, not a delivery-guaranteed queue; a message that
 * arrives late because it was retried through a Telegram outage is less useful
 * than a clear log line that says it was not delivered.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import https from 'https';
import { createLogger } from '../../utils/logger';
import type {
  TelegramApiResponse,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser,
  SendMessageParams,
} from './types';

const logger = createLogger('RONOR:Telegram:API');

export class TelegramApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly code: number | null,
    public readonly description: string,
  ) {
    super(`Telegram API error on ${method}: [${code ?? 'network'}] ${description}`);
    this.name = 'TelegramApiError';
  }
}

function post<T>(token: string, method: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options: https.RequestOptions = {
      hostname: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 35_000,
    };
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let parsed: TelegramApiResponse<T>;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TelegramApiResponse<T>;
        } catch {
          reject(new TelegramApiError(method, res.statusCode ?? null, 'non-JSON response body'));
          return;
        }
        if (!parsed.ok) {
          reject(
            new TelegramApiError(
              method,
              parsed.error_code ?? res.statusCode ?? null,
              parsed.description ?? 'unknown error',
            ),
          );
          return;
        }
        resolve(parsed.result as T);
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new TelegramApiError(method, null, 'request timed out after 35s'));
    });
    req.on('error', (err: Error) => reject(new TelegramApiError(method, null, err.message)));
    req.write(payload);
    req.end();
  });
}

export class TelegramApiClient {
  constructor(private readonly token: string) {}

  async getMe(): Promise<TelegramUser> {
    return post<TelegramUser>(this.token, 'getMe', {});
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return post<TelegramUpdate[]>(this.token, 'getUpdates', {
      offset,
      timeout,
      allowed_updates: ['message', 'callback_query'],
    });
  }

  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    return post<TelegramMessage>(this.token, 'sendMessage', params);
  }

  async editMessageText(params: {
    chat_id: number | string;
    message_id: number;
    text: string;
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> };
  }): Promise<TelegramMessage | boolean> {
    return post<TelegramMessage | boolean>(this.token, 'editMessageText', params);
  }

  async answerCallbackQuery(params: {
    callback_query_id: string;
    text?: string;
    show_alert?: boolean;
  }): Promise<boolean> {
    return post<boolean>(this.token, 'answerCallbackQuery', params);
  }

  async setWebhook(params: {
    url: string;
    secret_token?: string;
    allowed_updates?: string[];
    drop_pending_updates?: boolean;
  }): Promise<boolean> {
    return post<boolean>(this.token, 'setWebhook', params);
  }

  async deleteWebhook(params: { drop_pending_updates?: boolean }): Promise<boolean> {
    return post<boolean>(this.token, 'deleteWebhook', params);
  }

  /**
   * Send a message, chunking it if it exceeds `maxChars`.
   *
   * Long answers from the runtime are split on paragraph boundaries where
   * possible, so a chunk boundary does not fall mid-sentence. Telegram's hard
   * limit is 4096 characters; the bridge's default ceiling is 3800 to leave
   * room for the governance footer appended to the first chunk.
   */
  async sendChunked(
    chatId: number | string,
    text: string,
    maxChars: number,
    replyToMessageId?: number,
  ): Promise<void> {
    if (text.length <= maxChars) {
      await this.sendMessage({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_to_message_id: replyToMessageId,
      });
      return;
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining);
        break;
      }
      // Prefer a paragraph break; fall back to the last space; fall back to a
      // hard cut. A hard cut on a CJK string or a URL is ugly but not broken.
      let cut = remaining.lastIndexOf('\n\n', maxChars);
      if (cut < maxChars / 2) cut = remaining.lastIndexOf('\n', maxChars);
      if (cut < maxChars / 2) cut = remaining.lastIndexOf(' ', maxChars);
      if (cut <= 0) cut = maxChars;
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    for (let i = 0; i < chunks.length; i++) {
      const label = chunks.length > 1 ? `\n<i>(${i + 1}/${chunks.length})</i>` : '';
      await this.sendMessage({
        chat_id: chatId,
        text: chunks[i] + label,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_to_message_id: i === 0 ? replyToMessageId : undefined,
      });
    }
    logger.debug(`chunked message into ${chunks.length} parts for chat ${chatId}`);
  }
}
