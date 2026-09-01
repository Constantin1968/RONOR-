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

  // Obiectele nu se mai serializeaza integral. Serializarea completa scotea in
  // jurnal orice cimp al obiectului, inclusiv unele sensibile pe care apelantul
  // nu intentiona sa le scrie. Se pastreaza doar o descriere de forma.
  if (arg !== null && typeof arg === 'object') {
    const nume = (arg as { constructor?: { name?: string } }).constructor?.name ?? 'Object';
    const chei = Object.keys(arg as Record<string, unknown>);
    const listaChei = chei.slice(0, 12).map(sanitizeLogText).join(',');
    const rest = chei.length > 12 ? `,+${chei.length - 12}` : '';
    return `<${sanitizeLogText(nume)} chei=[${listaChei}${rest}]>`;
  }

  return sanitizeLogText(String(arg));
}

export function createLogger(namespace: string) {
  const log = (level: string, ...args: unknown[]) => {
    if (levels.indexOf(level) <= currentLevel) {
      const ts = new Date().toISOString();
      const prefix = `[${ts}] [${level.toUpperCase()}] [${namespace}]`;
      // Sanitizarea este aplicata direct aici, in acelasi loc unde se scrie, ca
      // bariera sa fie vizibila si pentru analiza statica: fiecare argument devine
      // un text fara CR/LF si fara caractere de control inainte de a ajunge la
      // consola. Nu se serializeaza obiecte intregi, tocmai ca sa nu se scurga
      // in jurnal cimpuri sensibile pe care apelantul nu a cerut sa fie scrise.
      const sanitizedArgs = args.map((arg) =>
        sanitizeLogArg(arg)
          .replace(/[\r\n]+/g, ' ')
          .replace(/[\u0000-\u001F\u007F]/g, ''),
      );
      if (level === 'error') {
        console.error('%s %s', prefix, sanitizedArgs.join(' '));
      } else {
        console.log('%s %s', prefix, sanitizedArgs.join(' '));
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
