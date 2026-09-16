# Operator — schelet Tranșa 1 (poartă, fără execuție)

> Scop: baza pe care crește Operatorul Automatizat Autonom fără să redeschidă porțile G0–G5. Acest schelet NU execută nimic: evaluează și blochează.

## Ce s-a adăugat

| Fișier | Rol | Poartă |
|---|---|---|
| `src/runtime/operator/actions.ts` | Acțiuni tipizate `ops.observe/repo.read/repo.edit/tests.run/vcs.commit_local/ops.actuate/notify.send` + validare args + modele interzise (secrete, rețea, `python -c`, `git push`, `rm -rf`, evadare workspace) | G1.1 (fix F02) |
| `src/runtime/operator/resource-lease.ts` | Lease pe resursă canonică: o singură deținere odată, eliberare de deținător, expirare | G1.4 (fix F09) |
| `src/runtime/operator/loop.ts` | Poarta OODA: mandat → buget → lease → acțiune tipizată → aprobare (`ops.actuate` cere `approved=true`) | G1+G2 |
| `tests/operator/*.test.ts` | 20 teste negative/proprietăți | — |

## Cum se folosește

```ts
import { ResourceLeaseManager } from './src/runtime/operator/resource-lease';
import { runOperatorTick } from './src/runtime/operator/loop';

const leases = new ResourceLeaseManager();
const decision = runOperatorTick({
  mandate, objective, workspaceRoot: '/work/proba-001', branch: 'proba/001',
  resource: '/work/proba-001', owner: 'operator-1',
  action: { type: 'repo.read', args: { path: 'src/sum.ts' } },
  allowedOperatorTypes: ['repo.read'],
  approved: false, costSoFarUsd: 0, leaseManager: leases, now: new Date(),
});
// { decision: 'ready_to_execute' } sau { decision: 'blocked', reason }
```

## Ce rămâne (Tranșa 2, intenționat neimplementat aici)

- Sandbox real + supervisor semnatar (F03/F04), kill pe grup procese (F15).
- Capabilitate semnată pe plic complet (F07), snapshot→teste→commit legat (F05), obiectiv în evaluator (F06).
- Variantă persistentă SQLite tranzacțională a lease-ului pe resursă.
- Percepție reală L0, actuatoare fizice cu `dry_run` + compensare, circuit-breaker, exit drill.
- Regula: niciun `ops.actuate` fără aprobare umană + receipt legat, până la G1–G2 verzi.
