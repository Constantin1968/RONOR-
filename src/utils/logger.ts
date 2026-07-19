/**
 * RONOR Logger Utility
 */

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const levels = ['error', 'warn', 'info', 'debug'];
const currentLevel = levels.indexOf(LOG_LEVEL);

export function createLogger(namespace: string) {
  const log = (level: string, ...args: unknown[]) => {
    if (levels.indexOf(level) <= currentLevel) {
      const ts = new Date().toISOString();
      const prefix = `[${ts}] [${level.toUpperCase()}] [${namespace}]`;
      if (level === 'error') {
        console.error(prefix, ...args);
      } else {
        console.log(prefix, ...args);
      }
    }
  };

  return {
    error: (...args: unknown[]) => log('error', ...args),
    warn: (...args: unknown[]) => log('warn', ...args),
    info: (...args: unknown[]) => log('info', ...args),
    debug: (...args: unknown[]) => log('debug', ...args),
  };
}
