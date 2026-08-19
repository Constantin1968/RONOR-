/**
 * RONOR — L0 · Telegram Interface · Entrypoint
 * ─────────────────────────────────────────────
 * Standalone entry point for the Telegram bridge container.
 *
 * In the production composition this runs as a separate container from the same
 * image, started with:
 *   command: ["node", "dist/interfaces/telegram/index.js"]
 *
 * It can also be started in-process alongside the runtime by importing and
 * calling `startTelegramBridge()` from src/index.ts — useful for single-host
 * deployments where a second container is unnecessary overhead.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import 'dotenv/config';
import { createLogger } from '../../utils/logger';
import { loadTelegramConfig, describeConfig, TelegramConfigError } from './config';
import { RonorTelegramBot } from './bot';

const logger = createLogger('RONOR:Telegram:Main');

export async function startTelegramBridge(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║  RONOR — Telegram Operator Interface             ║');
  logger.info('║  Sovereign Intelligence Operating Runtime        ║');
  logger.info('║  Prepared by AMB · Mayleven Ecosystem            ║');
  logger.info('╚══════════════════════════════════════════════════╝');

  let config;
  try {
    config = loadTelegramConfig(env);
  } catch (err) {
    if (err instanceof TelegramConfigError) {
      logger.error('Configuration error:', err.message);
      logger.error('The bridge will not start. Fix the configuration and restart.');
      process.exit(1);
    }
    throw err;
  }

  logger.info('Configuration resolved:', describeConfig(config));

  const bot = new RonorTelegramBot(config);

  // Graceful shutdown. The bot's stop() method clears the poll loop and the
  // prune interval; a hard kill leaves no cleanup to do, but a graceful stop
  // lets the current update finish processing rather than abandoning it mid-way.
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received — stopping bot`);
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException:', err);
    // Do not exit: a single malformed update must not take the bridge down.
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection:', reason);
  });

  await bot.start();
  logger.info('Telegram bridge running');
}

// Run when executed directly (node dist/interfaces/telegram/index.js).
// The check is reliable for CommonJS; for ESM it would be `import.meta.url`.
if (require.main === module) {
  void startTelegramBridge();
}
