# Operator — schelet Tranșa 1 (poartă, fără execuție)

> Scop: baza pe care crește Operatorul Automatizat Autonom fără să redeschidă porțile G0–G5. Acest schelet NU execută nimic: evaluează și blochează.

## Ce s-a adăugat

| Fișier | Rol | Poartă |
|---|---|---|
| `src/runtime/operator/actions.ts` | Acțiuni tipizate `ops.observe/repo.read/repo.edit/tests.run/vcs.commit_local/ops.actuate/notify.send`; tipurile permise derivate din mandat (`operatorTypesFromMandate`); listă albă de argumente pe tip, cu refuz pentru orice cheie necunoscută; modele interzise pe textul liber rămas (secrete, rețea, interpretoare cu cod în linie, `git push`, `rm -rf`, evadare workspace) | G1.1 (fix F02) |
| `src/runtime/operator/resource-lease.ts` | Lease pe resursă canonică: o singură deținere odată, eliberare de deținător, expirare | G1.4 (fix F09) |
| `src/runtime/operator/loop.ts` | Poarta OODA: mandat → buget → lease → acțiune tipizată (tipuri numai din mandat) → aprobare (`ops.actuate` cere o aprobare semnată, legată de hash-ul acțiunii și cu expirare; booleanul `approved` nu mai autorizează nimic) | G1+G2 |
| `src/runtime/executor/*` | Executorul cu mandat: singura cale de efect pe gazdă (vezi `docs/consolidation/executor-cu-mandat.md`) | G1+G2 (fix F07, F09, F04) |
| `tests/operator/*.test.ts`, `tests/executor/*.test.ts` | 96 de teste pentru poartă, plus testele executorului (aprobare, STOP, idempotență, contradicție, proveniență) | — |

## Cum se folosește

```ts
import { ResourceLeaseManager } from './src/runtime/operator/resource-lease';
import { runOperatorTick } from './src/runtime/operator/loop';

const leases = new ResourceLeaseManager();
const decision = runOperatorTick({
  mandate, objective, workspaceRoot: '/work/proba-001', branch: 'proba/001',
  resource: '/work/proba-001', owner: 'operator-1',
  action: { type: 'repo.read', args: { path: 'src/sum.ts' } },
  costSoFarUsd: 0, leaseManager: leases, now: new Date(),
  // Pentru ops.actuate: approval (semnată), approvalSecret și hostId.
});
// { decision: 'ready_to_execute' } sau { decision: 'blocked', reason }
```

## Reguli de poartă (după revizia din 25.09.2026)

- **Tipurile permise vin numai din mandat.** `operatorTypesFromMandate(mandate)` ia `allowed_actions`, scade `denied_actions` și traduce prin `OPERATOR_TYPE_MANDATE_ACTION`: `repo.read` → `read_repo`, `repo.edit` → `edit_worktree`, `tests.run` → `run_tests`, `vcs.commit_local` → `commit_local`, `notify.send` → `external_send`, `ops.observe` → `ops_observe`, `ops.actuate` → `ops_actuate`. Cele două acțiuni de operațiuni nu sunt în mandatul implicit de dezvoltare; le dă numai `issueOperationsMandate` (din `src/runtime/executor`), explicit. `external_send` rămâne nedelegabil, deci `notify.send` e refuzat întotdeauna. Apelantul nu mai poate transmite o listă proprie de tipuri.
- **Listă albă de argumente pe tip.** `repo.read` acceptă numai `path`; `repo.edit` numai `path` și `diffHash`; `tests.run` numai `suiteId`; `vcs.commit_local` numai `message`; `ops.observe` numai `target`; `ops.actuate` numai `device` și `command`; `notify.send` numai `channel` și `text`. Orice altă cheie dă `unknown_arg:<cheie>`.
- **Interpretoarele cu cod în linie se refuză** și în textul liber permis: `node -e`/`--eval`/`-p`, `bash -c`, `sh -c` (și `dash`, `zsh`, `ksh`), `perl -e`, `python -c`, `python3 -c`, `python3.11 -c` și orice `pythonX.Y -c`, `ruby -e`, `php -r`, inclusiv cu cale (`/usr/bin/python3.13`) și cu opțiuni grupate (`bash -lc`, `python3 -Ic`). Motiv: `interpreter_inline_code_forbidden`.

## Ce rămâne (Tranșa 2, intenționat neimplementat aici)

- Aprobarea pentru `ops.actuate` e acum legată de hash-ul acțiunii și de o expirare (lotul B, 25.09.2026).
- Refuzuri false ale filtrului de rețele private (de exemplu „versiunea 10.1.2.3” într-un mesaj) și `rm -r` fără `-f`, care trece.

- Sandbox real + supervisor semnatar (F03/F04), kill pe grup procese (F15).
- Capabilitate semnată pe plic complet (F07), snapshot→teste→commit legat (F05), obiectiv în evaluator (F06).
- Lease-ul din poartă (`resource-lease.ts`) rămâne în memorie; executorul are propriul lease persistent (SQLite) și reentrant pentru același deținător.
- Percepție reală L0, actuatoare fizice cu `dry_run` + compensare, circuit-breaker, exit drill.
- Regula: niciun `ops.actuate` fără aprobare umană legată de acțiune și chitanță semnată a executorului. Executorul o aplică în cod.
