/**
 * Workspace-escape analysis for the effect policy.
 *
 * The policy refuses any sign that a pending action would leave the isolated
 * worktree. Absolute escapes (`/etc`, `/root`, `/home`, `/var/run`, `~/`, a
 * Windows drive root) are refused unconditionally and are not treated here.
 *
 * This module answers one narrower question: a relative traversal sequence
 * (`../` or `..\`) has been found in the text of a pending action — is it a path
 * the worker proposes to traverse, or is it a character sequence inside the
 * search pattern of a read-only search command?
 *
 * The distinction is not cosmetic. On 16 September 2026 a real validation run
 * was refused with `workspace_escape_forbidden` and died with its mandate,
 * because the worker ran a strictly reading search for relative TypeScript
 * imports and the pattern itself contained `'../`. Searching for relative
 * imports is an ordinary operation in any TypeScript repository, so the rule as
 * written refuses a class of harmless reads and will keep doing so.
 *
 * The exemption granted here is deliberately the narrowest one that removes
 * that false refusal, and it rests on a property of the search tools rather
 * than on a guess about intent: for grep, ripgrep and their relatives, the
 * pattern operand is never opened as a file. A path operand of the same command
 * is not exempt; neither is a traversal anywhere else in the same action; and
 * an absolute escape inside a pattern is still refused, because it is detected
 * by its own rule before this analysis is consulted.
 *
 * Everything outside that single position stays refused, so the rule is not
 * weakened for real traversal.
 */

/**
 * Options that consume the following token as a value, per tool family. A token
 * consumed as a value is never the pattern operand, which is what keeps
 * `grep -f ../list` — a traversal to a pattern FILE — from being exempt.
 *
 * The tables are separated by family because the same letter means different
 * things: `-r` is recursion for grep and takes no value, while for ripgrep it is
 * `--replace` and does take one. A single merged table misreads `grep -rln` and
 * loses the pattern position, which is exactly the failure this analysis exists
 * to avoid.
 */
const GREP_VALUE_OPTIONS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '--after-context',
  '-B', '--before-context', '-C', '--context', '-D', '--devices', '-d', '--directories',
  '--exclude', '--exclude-dir', '--exclude-from', '--include', '--label', '--binary-files',
  '--color', '--colour', '--group-separator', '--ignore-dir', '--pager',
]);

const RIPGREP_VALUE_OPTIONS = new Set([
  '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '--after-context',
  '-B', '--before-context', '-C', '--context', '-g', '--glob', '--iglob',
  '-t', '--type', '-T', '--type-not', '-r', '--replace', '--pre', '--sort',
  '-j', '--threads', '--ignore-file', '--path-separator', '-M', '--max-columns',
  '--max-filesize', '--context-separator', '--color', '--colors', '--engine',
  '--dfa-size-limit', '--regex-size-limit', '--field-match-separator', '--max-depth',
]);

/** Search tools whose pattern operand is matched against text, never opened. */
const SEARCH_COMMANDS = new Map<string, Set<string>>([
  ['grep', GREP_VALUE_OPTIONS], ['egrep', GREP_VALUE_OPTIONS], ['fgrep', GREP_VALUE_OPTIONS],
  ['zgrep', GREP_VALUE_OPTIONS], ['ack', GREP_VALUE_OPTIONS], ['ag', GREP_VALUE_OPTIONS],
  ['rg', RIPGREP_VALUE_OPTIONS], ['ripgrep', RIPGREP_VALUE_OPTIONS],
]);

/** `git grep` is the same tool reached through the git front end. */
const GIT_SEARCH_SUBCOMMAND = 'grep';

/** The only options whose value IS the pattern. */
const PATTERN_OPTIONS = new Set(['-e', '--regexp']);

interface Token { text: string; start: number; end: number }

/**
 * Split text into shell-ish tokens, honouring quotes, and report each token's
 * span in the original text. Quote characters are kept inside the token so that
 * an index computed on the original text still lands inside its token.
 *
 * This is not a shell parser and does not pretend to be one. It is only precise
 * enough to answer which operand position a given character sits in; anything it
 * cannot resolve leaves the occurrence unexempt, which refuses the action.
 */
function tokenise(text: string): Token[][] {
  const commands: Token[][] = [];
  let tokens: Token[] = [];
  let current: string = '';
  let start = 0;
  let quote: '"' | "'" | null = null;

  const endToken = (index: number): void => {
    if (current.length > 0) tokens.push({ text: current, start, end: index });
    current = '';
  };
  const endCommand = (index: number): void => {
    endToken(index);
    if (tokens.length > 0) commands.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      if (current.length === 0) start = index;
      current += character;
      quote = character;
      continue;
    }
    if (character === '\\' && index + 1 < text.length) {
      // A backslash escape belongs to the token it sits in, including `\|`,
      // which is how a basic-regular-expression alternation is written.
      if (current.length === 0) start = index;
      current += character + text[index + 1];
      index += 1;
      continue;
    }
    if (character === ' ' || character === '\t' || character === '\r') { endToken(index); continue; }
    if (character === '\n' || character === ';') { endCommand(index); continue; }
    if (character === '|' || character === '&') {
      // `|`, `||`, `&&` and a trailing `&` all end a command.
      endCommand(index);
      if (text[index + 1] === character) index += 1;
      continue;
    }
    if (current.length === 0) start = index;
    current += character;
  }
  endCommand(text.length);
  return commands;
}

/** Strip leading `VAR=value` assignments, which precede the executable. */
function executableIndex(tokens: Token[]): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index].text)) index += 1;
  return index;
}

/** The base name of an executable token, so `/usr/bin/grep` resolves to `grep`. */
function baseName(token: string): string {
  const unquoted = token.replace(/^['"]|['"]$/g, '');
  const parts = unquoted.split('/');
  return parts[parts.length - 1];
}

/**
 * The span of the pattern operand of a search command, or null when the command
 * is not a search command or its pattern cannot be identified.
 */
function patternOperand(tokens: Token[]): Token | null {
  let index = executableIndex(tokens);
  if (index >= tokens.length) return null;
  const executable = baseName(tokens[index].text);
  let valueOptions: Set<string>;
  if (executable === 'git') {
    index += 1;
    // Skip git's own global options, which are few and take no value here.
    while (index < tokens.length && tokens[index].text.startsWith('-')) index += 1;
    if (index >= tokens.length || tokens[index].text !== GIT_SEARCH_SUBCOMMAND) return null;
    valueOptions = GREP_VALUE_OPTIONS;
  } else {
    const table = SEARCH_COMMANDS.get(executable);
    if (table === undefined) return null;
    valueOptions = table;
  }
  index += 1;

  for (let cursor = index; cursor < tokens.length; cursor += 1) {
    const token = tokens[cursor];
    if (token.text === '--') {
      // Everything after `--` is an operand; the first is the pattern.
      return cursor + 1 < tokens.length ? tokens[cursor + 1] : null;
    }
    if (token.text.startsWith('-') && token.text.length > 1) {
      const inline = /^(--?[A-Za-z0-9-]+)=/.exec(token.text);
      if (inline) {
        // `--regexp=PATTERN` carries the pattern; any other inline value does not.
        if (PATTERN_OPTIONS.has(inline[1])) return token;
        continue;
      }
      if (valueOptions.has(token.text)) {
        const value = tokens[cursor + 1];
        if (value === undefined) return null;
        if (PATTERN_OPTIONS.has(token.text)) return value;
        cursor += 1;
        continue;
      }
      // A short option cluster such as `-rln` takes no value in this table. If
      // it ends in a value-taking letter the cluster is ambiguous, so refuse to
      // resolve rather than guess.
      if (/^-[A-Za-z]{2,}$/.test(token.text)
        && token.text.slice(1).split('').some((letter) => valueOptions.has(`-${letter}`))) return null;
      continue;
    }
    return token;
  }
  return null;
}

/**
 * True when a relative traversal at `offset` inside `text` sits in the pattern
 * operand of a read-only search command, and is therefore matched as characters
 * rather than traversed as a path.
 *
 * Any doubt returns false, which leaves the refusal in place.
 */
export function relativeEscapeIsSearchPattern(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= text.length) return false;
  for (const tokens of tokenise(text)) {
    const first = tokens[0];
    const last = tokens[tokens.length - 1];
    if (first === undefined || last === undefined) continue;
    if (offset < first.start || offset >= last.end) continue;
    const operand = patternOperand(tokens);
    if (operand === null) return false;
    return offset >= operand.start && offset < operand.end;
  }
  return false;
}
