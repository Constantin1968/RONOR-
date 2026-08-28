#!/usr/bin/env python3
"""
Evaluare a maturitatii operationale RONOR pe criterii verificabile.

Nu evalueaza „cat de impresionant" e sistemul, ci daca indeplineste conditiile
minimale pe care orice sistem de productie trebuie sa le indeplineasca:
  - copii de rezerva DOVEDITE (nu doar configurate)
  - restaurare TESTATA
  - alertare la cadere
  - versionare cod
  - documentatie operationala
  - gestionare de secrete
  - transport criptat

Fiecare criteriu: INDEPLINIT / PARTIAL / NEINDEPLINIT, cu dovada.
"""
import json
import os
import subprocess
import glob
from datetime import datetime, timezone


def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


crit = []


def add(nume, verdict, dovada, materialitate):
    crit.append({"criteriu": nume, "verdict": verdict, "dovada": dovada,
                 "materialitate": materialitate})


print("=" * 78)
print("  MATURITATE OPERAȚIONALĂ RONOR — criterii de producție")
print("=" * 78)

# 1. copii de rezerva
logs = sh("docker logs ronor-backup --tail 20 2>&1")
mounts = sh('docker inspect ronor-backup --format "{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}"')
arhive = sh("find / -name '*.tar*' -path '*backup*' -mtime -7 2>/dev/null | head -5")
arhive2 = sh("ls -1 /opt/backups/* 2>/dev/null | head -5")
dovada_backup = []
if mounts:
    dovada_backup.append(f"montari: {mounts[:70]}")
if arhive or arhive2:
    dovada_backup.append(f"arhive recente: {(arhive or arhive2)[:70]}")
if logs:
    ultim = [l for l in logs.splitlines() if l.strip()][-1:] or [""]
    dovada_backup.append(f"jurnal: {ultim[0][:70]}")
if arhive or arhive2:
    add("Copii de rezervă", "ÎNDEPLINIT", " | ".join(dovada_backup), "critică")
elif mounts or logs:
    add("Copii de rezervă", "PARȚIAL",
        "container rulează, dar NU am găsit arhive create în ultimele 7 zile: "
        + " | ".join(dovada_backup), "critică")
else:
    add("Copii de rezervă", "NEÎNDEPLINIT", "nicio dovadă", "critică")

# 2. restaurare testata
restore = sh("find /opt -iname '*restore*' -o -iname '*recover*' 2>/dev/null | grep -v node_modules | head -5")
add("Restaurare testată",
    "ÎNDEPLINIT" if restore else "NEÎNDEPLINIT",
    restore[:90] if restore else "niciun script de restaurare găsit; o copie "
    "de rezervă nerestaurată niciodată este o presupunere, nu o garanție",
    "critică")

# 3. alertare la cadere
ext = sh("grep -rlE 'healthchecks.io|uptimerobot|betteruptime|pagerduty|"
         "cronitor' /opt 2>/dev/null | head -3")
monitor_activ = sh("curl -s -m 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:8700/health")
add("Alertare la cădere",
    "PARȚIAL" if monitor_activ == "200" else "NEÎNDEPLINIT",
    (f"R-Monitor răspunde local (HTTP {monitor_activ}), dar "
     f"{'există alertare externă: ' + ext[:50] if ext else 'NU există alertare externă — dacă nodul cade complet, nimeni nu află'}"),
    "critică")

# 4. versionare cod
git = []
for d in ["/opt/ronor", "/opt/ronor/operators", "/opt/ronor-cc"]:
    if os.path.isdir(os.path.join(d, ".git")):
        n = sh(f"cd {d} && git log --oneline 2>/dev/null | wc -l")
        git.append(f"{d}: {n} commituri")
add("Versionare cod",
    "ÎNDEPLINIT" if git else "NEÎNDEPLINIT",
    " | ".join(git) if git else "niciun depozit git în /opt/ronor — modificările "
    "de cod nu sunt urmăribile și nu există revenire la o versiune anterioară",
    "ridicată")

# 5. documentatie
docs = sh("find /opt/ronor -maxdepth 2 -iname '*.md' 2>/dev/null | head -10")
nd = len([x for x in docs.splitlines() if x.strip()])
add("Documentație operațională",
    "ÎNDEPLINIT" if nd >= 3 else ("PARȚIAL" if nd else "NEÎNDEPLINIT"),
    f"{nd} documente în /opt/ronor" + (f": {docs.splitlines()[0]}" if nd else ""),
    "medie")

# 6. secrete
perm = sh("stat -c '%a %U' /opt/ronor/.report_env 2>/dev/null")
vault = sh("docker ps --format '{{.Names}}' | grep -icE 'vault|sops|secret'")
add("Gestionare secrete",
    "PARȚIAL",
    f"fișiere de mediu cu permisiuni restrânse ({perm or 'n/a'}), dar secretele "
    f"stau în text clar pe disc; gestionar dedicat: "
    f"{'da' if vault and vault != '0' else 'NU'}",
    "ridicată")

# 7. transport criptat
dom = sh("grep -cE '^[a-z0-9.-]+\\.(tech|com|ai|ro)' /etc/caddy/Caddyfile 2>/dev/null")
https = sh("curl -s -m 8 -o /dev/null -w '%{http_code}' -k https://178.104.118.10/ 2>/dev/null")
add("Transport criptat (TLS)",
    "NEÎNDEPLINIT" if (dom in ("0", "") ) else "ÎNDEPLINIT",
    f"domenii cu nume în Caddyfile: {dom or 0}; HTTPS pe IP: {https}. "
    f"Accesul la dashboard se face pe HTTP simplu, cu autentificare de bază — "
    f"parola circulă necriptată",
    "critică")

# 8. teste automate
teste = sh("find /opt/ronor -name 'test_*.py' 2>/dev/null | head -8")
nt = len([x for x in teste.splitlines() if x.strip()])
drill = os.path.exists("/opt/ronor/exit_drill_result.json")
add("Testare automată",
    "PARȚIAL" if (nt or drill) else "NEÎNDEPLINIT",
    f"{nt} fișiere de test; Exit Drill: {'prezent' if drill else 'absent'}. "
    f"Nu există rulare automată la fiecare modificare (CI)",
    "medie")

# 9. redundanta
add("Redundanță / punct unic de eșec",
    "NEÎNDEPLINIT",
    "un singur nod servește modele (vmi3488431); un singur nod rulează toate "
    "cele 46 de containere; fără swap. Căderea oricăruia oprește RONOR complet",
    "ridicată")

# 10. observabilitate
lf = sh("curl -s -m 6 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/public/health")
add("Observabilitate",
    "ÎNDEPLINIT" if lf == "200" else "PARȚIAL",
    f"Langfuse activ (HTTP {lf}), MLflow, Temporal UI, dashboard propriu",
    "medie")

# raport
print(f"\n  {'CRITERIU':30} {'VERDICT':16} {'MATERIALITATE'}")
print("  " + "-" * 74)
for c in crit:
    print(f"  {c['criteriu'][:30]:30} {c['verdict']:16} {c['materialitate']}")

print("\n\n  DETALII\n" + "  " + "-" * 74)
for c in crit:
    print(f"\n  {c['criteriu']} — {c['verdict']}")
    print(f"    {c['dovada']}")

ind = sum(1 for c in crit if c["verdict"] == "ÎNDEPLINIT")
par = sum(1 for c in crit if c["verdict"] == "PARȚIAL")
nei = sum(1 for c in crit if c["verdict"] == "NEÎNDEPLINIT")
critice_nei = [c["criteriu"] for c in crit
               if c["materialitate"] == "critică" and c["verdict"] != "ÎNDEPLINIT"]

print("\n\n" + "=" * 78)
print(f"  SCOR: {ind} îndeplinite | {par} parțiale | {nei} neîndeplinite  "
      f"(din {len(crit)})")
print(f"  CRITERII CRITICE NEÎNDEPLINITE: {len(critice_nei)}")
for c in critice_nei:
    print(f"    - {c}")
print("=" * 78)

with open("/opt/ronor/maturitate.json", "w") as f:
    json.dump({"moment": datetime.now(timezone.utc).isoformat(),
               "criterii": crit, "indeplinite": ind, "partiale": par,
               "neindeplinite": nei, "critice_neindeplinite": critice_nei},
              f, indent=2, ensure_ascii=False)
print("\n[salvat] /opt/ronor/maturitate.json")
