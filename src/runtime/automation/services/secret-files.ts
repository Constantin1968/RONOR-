import { readFileSync } from 'node:fs';

/** Load a secret from NAME_FILE first, falling back to NAME for local use. */
export function secretValue(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[`${name}_FILE`];
  const raw = file ? readFileSync(file, { encoding: 'utf8', flag: 'r' }) : env[name];
  const value = raw?.trim();
  return value || undefined;
}

export function requiredSecret(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = secretValue(name, env);
  if (!value) throw new Error(`${name}_required`);
  return value;
}
