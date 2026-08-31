/**
 * RONOR Logger Utility
 */

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const levels = ['error', 'warn', 'info', 'debug'];
const currentLevel = levels.indexOf(LOG_LEVEL);

function sanitizeLogText(input: string): string {
  return input.replace(/[\r\n]+/g, ' ');
}

function sanitizeLogArg(arg: unknown): string {
  if (typeof arg === 'string') {
    return sanitizeLogText(arg);
  }

  // Erorile isi pastreaza urma de stiva, altfel remedierea de injectie in jurnal
  // ar distruge singura informatie utila la depanare. Separatorul de cadre este
  // vizibil, dar linia ramane unica, deci injectia nu mai e posibila.
  if (arg instanceof Error) {
    const cap = `${arg.name}: ${sanitizeLogText(arg.message)}`;
    if (typeof arg.stack !== 'string' || arg.stack.length === 0) {
      return cap;
    }
    const stiva = arg.stack
      .split(/[\r\n]+/)
      .map((linie) => linie.trim())
      .filter((linie) => linie.length > 0)
      .slice(1)
      .join(' | ');
    return stiva.length > 0 ? `${cap} | ${stiva}` : cap;
  }

  try {
    return sanitizeLogText(JSON.stringify(arg));
  } catch {
    return sanitizeLogText(String(arg));
  }
}

export function createLogger(namespace: string) {
  const log = (level: string, ...args: unknown[]) => {
    if (levels.indexOf(level) <= currentLevel) {
      const ts = new Date().toISOString();
      const prefix = `[${ts}] [${level.toUpperCase()}] [${namespace}]`;
      const sanitizedArgs = args.map(sanitizeLogArg);
      if (level === 'error') {
        console.error(prefix, ...sanitizedArgs);
      } else {
        console.log(prefix, ...sanitizedArgs);
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
