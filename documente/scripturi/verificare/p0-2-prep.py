#!/usr/bin/env python3
# Pregateste, FARA a aplica, cele trei variante pentru P0-2:
# radacina publica http://178.104.118.10/ serveste acum Langfuse (127.0.0.1:3000).
import re, subprocess, shutil, sys

SRC = "/etc/caddy/Caddyfile"
src = open(SRC, encoding="utf-8").read()
lines = src.split("\n")

# 1) Localizeaza blocul catch-all din interiorul blocului :80
idx = None
for i, l in enumerate(lines):
    if re.match(r"^\s*handle\s*\{\s*$", l):
        nxt = lines[i+1] if i+1 < len(lines) else ""
        if "reverse_proxy" in nxt and "127.0.0.1:3000" in nxt:
            idx = i
            break
if idx is None:
    print("EROARE: nu am gasit blocul catch-all handle { reverse_proxy 127.0.0.1:3000 }")
    sys.exit(1)

# Numara acoladele ca sa gasesti inchiderea reala a blocului handle,
# nu inchiderea blocului imbricat al lui reverse_proxy.
depth = 0
end = None
for k in range(idx, len(lines)):
    depth += lines[k].count("{") - lines[k].count("}")
    if depth == 0:
        end = k
        break
if end is None:
    print("EROARE: bloc handle neinchis")
    sys.exit(1)
ind = re.match(r"^(\s*)", lines[idx]).group(1)
print("catch-all gasit la liniile %d-%d, indentare %d spatii" % (idx+1, end+1, len(ind)))
print("continut actual:")
for l in lines[idx:end+1]:
    print("   " + l)

# 2) Extrage credentialul basic_auth existent din vhost-ul control (fara a-l afisa)
cred = None
for i, l in enumerate(lines):
    if re.search(r"^\s*basic_auth\s*\{", l):
        j = i + 1
        while j < len(lines) and not re.match(r"^\s*\}\s*$", lines[j]):
            parts = lines[j].split()
            if len(parts) >= 2 and parts[1].startswith("$2"):
                cred = (parts[0], parts[1])
            j += 1
        if cred:
            break
print("credential basic_auth reutilizabil: utilizator=%s, hash bcrypt de %d caractere (neafisat)"
      % (cred[0], len(cred[1])) if cred else "credential basic_auth: NEGASIT")

variante = {}

# Varianta A - inchidere totala: radacina nu mai serveste nimic public.
variante["A-inchidere"] = [
    ind + "handle {",
    ind + "\trespond \"Not Found\" 404",
    ind + "}",
]

# Varianta B - autentificare: aceeasi poarta ca /control, cu acelasi credential.
if cred:
    variante["B-autentificare"] = [
        ind + "handle {",
        ind + "\tbasic_auth {",
        ind + "\t\t%s %s" % (cred[0], cred[1]),
        ind + "\t}",
        ind + "\theader {",
        ind + "\t\tX-Content-Type-Options nosniff",
        ind + "\t\tX-Frame-Options DENY",
        ind + "\t\tReferrer-Policy no-referrer",
        ind + "\t\t-Server",
        ind + "\t}",
        ind + "\treverse_proxy 127.0.0.1:3000",
        ind + "}",
    ]

# Varianta C - pagina neutra: nimic nu dezvaluie ce ruleaza pe gazda.
variante["C-pagina-neutra"] = [
    ind + "handle {",
    ind + "\theader {",
    ind + "\t\tContent-Type \"text/plain; charset=utf-8\"",
    ind + "\t\t-Server",
    ind + "\t}",
    ind + "\trespond \"RONOR\" 200",
    ind + "}",
]

print()
for nume, corp in variante.items():
    out = lines[:idx] + corp + lines[end+1:]
    path = "/tmp/Caddyfile.%s" % nume
    open(path, "w", encoding="utf-8").write("\n".join(out))
    r = subprocess.run(["caddy", "validate", "--config", path, "--adapter", "caddyfile"],
                       capture_output=True, text=True)
    ok = "VALID" if r.returncode == 0 else "INVALID"
    delta = len(out) - len(lines)
    print("varianta %-16s -> %-7s  %s  (%+d linii, total %d)" % (nume, ok, path, delta, len(out)))
    if r.returncode != 0:
        print((r.stderr or r.stdout).strip()[:400])

# 3) Efectul asupra rutei: verifica in JSON-ul adaptat pentru fiecare varianta
print()
print("verificare in configuratia adaptata (ce raspunde radacina):")
import json
for nume in variante:
    path = "/tmp/Caddyfile.%s" % nume
    r = subprocess.run(["caddy", "adapt", "--config", path, "--adapter", "caddyfile"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print("  %-16s adaptare eșuată" % nume); continue
    j = json.loads(r.stdout)
    srv = j["apps"]["http"]["servers"]
    tinta = None
    for name, s in srv.items():
        for route in s.get("routes", []):
            for h in route.get("handle", []):
                if h.get("handler") == "subroute":
                    for sub in h.get("routes", []):
                        if not sub.get("match"):
                            for hh in sub.get("handle", []):
                                if hh.get("handler") in ("static_response", "reverse_proxy"):
                                    if tinta is None:
                                        tinta = (name, hh.get("handler"),
                                                 hh.get("status_code") or
                                                 [u.get("dial") for u in hh.get("upstreams", [])])
    print("  %-16s ultima ruta fara potrivire -> %s" % (nume, tinta))
