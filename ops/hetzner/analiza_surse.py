#!/usr/bin/env python3
"""
Analiza completa a surselor externe conectate la CIDA.

Distinctii de acuratete aplicate:
  - „inregistrata" != „functionala": o sursa poate exista in registru si sa nu fi
    adus niciodata un document (items_total=0) sau sa fie in stare `skipped`
  - `last_status` arata ce s-a intamplat la ULTIMA rulare, nu daca sursa e utila
  - fiabilitatea (A/B/C) e atribuita manual la creare, nu masurata
"""
import json
import os
import subprocess
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from source_quality import coverage, quality_summary


def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True,
                           timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


try:
    # No shell interpolation or credential in process arguments.
    config = json.loads(subprocess.run(
        ["docker", "inspect", "cida-api"], check=True, capture_output=True,
        text=True, timeout=20).stdout)
    env = dict(value.split("=", 1) for value in config[0]["Config"]["Env"] if "=" in value)
    key = env.get("CIDA_ROOT_API_KEY")
    if not key:
        raise ValueError("CIDA credential missing")
    request = urllib.request.Request(
        "http://127.0.0.1:8300/sources", headers={"X-API-Key": key})
    with urllib.request.urlopen(request, timeout=25) as response:
        d = json.load(response)
    if not isinstance(d.get("sources"), list):
        raise ValueError("Invalid source registry response")
except Exception as e:
    print(f"Citirea registrului a eșuat: {type(e).__name__}; nicio acoperire nu este declarată.")
    raise SystemExit(1)

surse = d.get("sources", [])
print("=" * 78)
print(f"  SURSE EXTERNE CIDA — {len(surse)} înregistrate")
print("=" * 78)

# grupare pe disciplina
pe_disc = defaultdict(list)
for s in surse:
    pe_disc[s.get("discipline") or "?"].append(s)

for disc in sorted(pe_disc, key=lambda k: -len(pe_disc[k])):
    lot = pe_disc[disc]
    total_items = sum(x.get("items_total") or 0 for x in lot)
    print(f"\n\n### {disc} — {len(lot)} surse, {total_items} elemente colectate")
    print(f"  {'NUME':32} {'TIP':11} {'FIAB':4} {'ELEM':>6} {'ULTIMA STARE':12}")
    for s in sorted(lot, key=lambda x: -(x.get("items_total") or 0)):
        nume = str(s.get("name"))[:32]
        tip = str(s.get("kind"))[:11]
        fiab = str(s.get("reliability") or "?")
        it = s.get("items_total") or 0
        st = str(s.get("last_status") or "niciodată")[:12]
        activ = "" if s.get("enabled") else "  [DEZACTIVATĂ]"
        print(f"  {nume:32} {tip:11} {fiab:4} {it:>6} {st:12}{activ}")

print("\n\n" + "=" * 78)
print("  ANALIZĂ DE FUNCȚIONALITATE REALĂ")
print("=" * 78)

productive = [s for s in surse if (s.get("items_total") or 0) > 0]
sterile = [s for s in surse if (s.get("items_total") or 0) == 0]
dezactivate = [s for s in surse if not s.get("enabled")]

st = Counter(str(s.get("last_status") or "niciodată") for s in surse)
kind = Counter(str(s.get("kind")) for s in surse)

print(f"\n  Surse care au adus cel puțin un document : {len(productive)}")
print(f"  Surse cu ZERO documente                  : {len(sterile)}")
print(f"  Surse dezactivate                        : {len(dezactivate)}")
print(f"\n  Total elemente colectate: {sum((s.get('items_total') or 0) for s in surse)}")
calitate = quality_summary(surse)
print("  ATENȚIE: contoare cumulative brute, NU documente unice sau acoperire recentă.")
print(f"  Surse de test separate: {calitate['test_sources']}, "
      f"{calitate['test_raw_items']} elemente brute.")
print("  Stare ok fără elemente (de verificat): " + ", ".join(calitate["ok_without_items"]))
print("  Fiabilitate în afara scalei literale: " + ", ".join(calitate["non_letter_reliability"]))

print(f"\n  Pe stare la ultima rulare:")
for k, v in st.most_common():
    print(f"    {k:16} {v}")

print(f"\n  Pe tip de sursă:")
for k, v in kind.most_common():
    print(f"    {k:16} {v}")

print(f"\n  --- CELE MAI PRODUCTIVE 8 SURSE ---")
for s in sorted(productive, key=lambda x: -(x.get("items_total") or 0))[:8]:
    uri = str(s.get("uri") or "(fără URI — import manual)")[:52]
    print(f"    {str(s.get('name'))[:28]:28} {s.get('items_total'):>6}  {uri}")

print(f"\n  --- SURSE STERILE (0 elemente) ---")
for s in sterile:
    motiv = str(s.get("last_status") or "nerulată")
    print(f"    {str(s.get('name'))[:30]:30} {str(s.get('kind'))[:10]:10} {motiv}")

# categorii lipsa — analiza de acoperire
print("\n\n" + "=" * 78)
print("  ACOPERIRE PE DOMENII DE INTERES ALE PRINCIPALULUI")
print("=" * 78)

toate_uri = " ".join(str(s.get("uri") or "") + " " + str(s.get("name") or "")
                     for s in surse).lower()

DOMENII = {
    "Academic / cercetare": ["arxiv", "nature", "science", "pubmed", "crossref",
                             "semantic", "openalex", "ssrn", "repec"],
    "Energie / piețe electricitate": ["entsoe", "eia", "iea", "opsd", "ember",
                                      "elexon", "nordpool", "epex", "opcom"],
    "Piețe de capital": ["sec", "edgar", "yahoo", "finance", "nasdaq",
                         "bloomberg", "refinitiv", "fred", "tradingeconomics"],
    "Macro / statistică oficială": ["worldbank", "imf", "oecd", "eurostat",
                                    "ecb", "bis", "insse"],
    "AI / tehnologie": ["huggingface", "papers", "github", "techcrunch",
                        "arxiv", "openai", "anthropic"],
    "Registre corporative": ["companies-house", "gleif", "lei", "opencorporates",
                             "onrc", "orbis"],
    "Proprietate intelectuală": ["uspto", "euipo", "ukipo", "wipo", "osim",
                                 "tmview", "espacenet"],
    "Geopolitică / politici": ["gdelt", "acled", "crisisgroup", "eur-lex",
                               "consilium", "reuters", "bbc"],
    "Meteo (critic pentru trading energie)": ["ecmwf", "noaa", "meteo", "weather",
                                              "openweather", "dwd", "anm"],
}

print(f"  {'DOMENIU':40} ÎNREGISTRATE / PRODUCTIVE ISTORIC / ACOPERIRE RECENTĂ")
lipsa = []
acoperire = {}
for dom, chei in DOMENII.items():
    rezultat = coverage(surse, chei)
    acoperire[dom] = rezultat
    print(f"  {dom[:40]:40} {rezultat['registered']} / "
          f"{rezultat['historically_productive']} / {rezultat['recent_coverage']}")
    if rezultat["recent_coverage"] != "verified":
        lipsa.append(dom)

print(f"\n  DOMENII CU ACOPERIRE RECENTĂ NEDEMONSTRATĂ: {len(lipsa)}")
print("  Cuvintele-cheie clasifică sursele, nu dovedesc acoperirea. "
      "Lipsa datelor unice recente înseamnă necunoscut, nu zero colectări.")
for l in lipsa:
    print(f"    - {l}")

with open("/opt/ronor/analiza_surse.json", "w") as f:
    json.dump({"total": len(surse), "productive": len(productive),
               "sterile": len(sterile), "dezactivate": len(dezactivate),
               "pe_disciplina": {k: len(v) for k, v in pe_disc.items()},
               "stari": dict(st), "tipuri": dict(kind),
               "domenii_lipsa": lipsa,
               "acoperire_masurata": acoperire, "calitate": calitate,
               "surse": surse}, f, indent=2, ensure_ascii=False, default=str)
print("\n[salvat] /opt/ronor/analiza_surse.json")
