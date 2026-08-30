#!/usr/bin/env python3
# P0-1 — inchiderea celor 13 cai operationale la marginea Caddy.
# Inserare punctuala dupa linia 27 (encode zstd gzip din blocul :80).
# Nu rescrie fisierul: citeste liniile, insereaza, scrie inapoi.
import io, sys

PATH = "/etc/caddy/Caddyfile"
MARK = "@operational_public"

PATHS = "/gw/* /temporal* /langgraph/* /crewai* /r-monitor/* /r-execute/* /r-schedule/* /guardrails/* /nemo/* /lakera/* /comms* /memory* /dashboard* /qdrant/*"

BLOCK = [
    "",
    "    # -----------------------------------------------------------------------",
    "    # P0-1 — plan operational: accesibil doar din tailnet si din reteaua interna.",
    "    # Inserat pentru inchiderea expunerilor E-01...E-06.",
    "    # respond este evaluat inaintea handle/handle_path in ordinea implicita.",
    "    # -----------------------------------------------------------------------",
    "    " + MARK + " {",
    "        path " + PATHS,
    "        not remote_ip 100.64.0.0/10 172.20.0.0/16 127.0.0.1/8",
    "    }",
    "    respond " + MARK + " \"Forbidden\" 403 {",
    "        close",
    "    }",
    "",
]

with io.open(PATH, "r", encoding="utf-8") as f:
    lines = f.read().split("\n")

if any(MARK in l for l in lines):
    print("ABORT: blocul P0-1 exista deja in configuratie. Nimic nu s-a modificat.")
    sys.exit(2)

# ancora: primul 'encode zstd gzip' care apare dupa linia care deschide ':80 {'
anchor = None
in80 = False
for i, l in enumerate(lines):
    if l.strip().startswith(":80") and l.strip().endswith("{"):
        in80 = True
        continue
    if in80 and l.strip() == "encode zstd gzip":
        anchor = i
        break

if anchor is None:
    print("ABORT: nu am gasit ancora 'encode zstd gzip' in blocul :80.")
    sys.exit(3)

out = lines[:anchor + 1] + BLOCK + lines[anchor + 1:]

with io.open(PATH, "w", encoding="utf-8") as f:
    f.write("\n".join(out))

print("OK: inserat dupa linia %d. Linii inainte: %d, dupa: %d."
      % (anchor + 1, len(lines), len(out)))
