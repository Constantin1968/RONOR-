#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Randor de rapoarte RONOR. Nu masoara nimic: citeste censul si il reda.

Cine masoara nu formateaza, cine formateaza nu masoara. Orice canal
(OBD, CBD, TODO, sanatate proactiva) e un glas al aceluiasi cens, deci
cifrele nu mai pot sa difere intre canale.
"""
import json
import sys
from datetime import datetime

ZILE = ["luni", "marți", "miercuri", "joi", "vineri", "sâmbătă", "duminică"]

SEMNE = {"verificat": "✓", "derivat": "≈", "neverificat": "?"}


def v(masuratoare, implicit="—"):
    if not isinstance(masuratoare, dict):
        return implicit
    val = masuratoare.get("valoare")
    return implicit if val is None else val


def sursa_scurta(masuratoare, lung=54):
    if not isinstance(masuratoare, dict):
        return ""
    s = masuratoare.get("sursa", "")
    return s if len(s) <= lung else s[:lung - 1] + "…"


def linie(eticheta, masuratoare, sufix="", latime=17):
    val = v(masuratoare)
    semn = SEMNE.get(masuratoare.get("incredere", ""), " ") \
        if isinstance(masuratoare, dict) else " "
    txt = "  %-*s: %s%s" % (latime, eticheta, val, sufix)
    return "%-46s %s %s" % (txt, semn, sursa_scurta(masuratoare))


def randeaza(cens, tip="CBD", cu_provenienta=True):
    L = []
    A = L.append
    try:
        dt = datetime.fromisoformat(cens["generat_la"])
        cap = "%s %s EEST" % (ZILE[dt.weekday()], dt.strftime("%d.%m.%Y %H:%M"))
    except Exception:
        cap = cens.get("generat_la", "?")

    titluri = {"OBD": "RONOR — DESCHIDEREA ZILEI",
               "CBD": "RONOR — ÎNCHIDEREA ZILEI",
               "TODO": "RONOR — TO-DO GENERAL (săptămânal)",
               "SANATATE": "RONOR — SĂNĂTATE PROACTIVĂ"}
    A(titluri.get(tip, "RONOR — RAPORT"))
    A("=" * 46)
    A(cap)
    A("Nod: %s   cens: %s" % (cens.get("nod", "?"), cens.get("schema", "?")))
    A("")

    # ---------------------------------------------------------- verdict
    vd = cens["verdict"]
    grad = v(vd["grad"])
    A("VERDICT: %s" % grad)
    coduri = v(vd["coduri"], []) or []
    if not coduri:
        A("  Niciun motiv de îngrijorare declarat.")
    for c in coduri:
        A("  [%s] %s  (%s)" % (c["greutate"][:3].upper(), c["text"], c["cod"]))
    A("")
    A("  Regula: DEGRADAT doar la serviciu critic căzut sau container oprit")
    A("  nedeclarat. Ce e oprit deliberat nu produce niciodată degradare.")
    A("")

    # ---------------------------------------------------------- infrastructura
    A("INFRASTRUCTURĂ")
    c = cens["containere"]
    if "eroare" in c:
        A("  NEVERIFICABIL — %s" % c["eroare"].get("motiv"))
    else:
        A(linie("Total", c["total"]))
        A(linie("Rulează", c["ruleaza"]))
        A(linie("Sănătoase", c["sanatos"]))
        nea = c.get("fara_sonda_neacoperite", {}).get("valoare", [])
        tot_fs = c["fara_verificare_sanatate"]["valoare"]
        A(linie("Fără healthcheck", c["fara_verificare_sanatate"],
                " (din care %d acoperite de sondă declarată)" % (tot_fs - len(nea))))
        if nea:
            A("      stare necunoscută: " + ", ".join(nea[:6]))
        A(linie("Nesănătoase", c["nesanatos"]))
        od = v(c["oprite_deliberat"], []) or []
        A("  %-17s: %d" % ("Oprite deliberat", len(od)))
        for x in od[:8]:
            A("      · %s — %s" % (x["nume"], x["motiv"]))
        on = v(c["oprite_neasteptat"], []) or []
        A("  %-17s: %d" % ("Oprite neașteptat", len(on)))
        for x in on[:8]:
            A("      ! %s" % x)
    A("")

    # ---------------------------------------------------------- servicii
    A("SERVICII CRITICE (fiecare cu sonda lui declarată)")
    for nume, s in cens["servicii"].items():
        val = s.get("valoare") or {}
        if s.get("incredere") == "neverificat":
            mark = " ? "
        elif val.get("viu"):
            mark = "ok "
        else:
            mark = "!! "
        detaliu = val.get("stare", "?")
        if "cod" in val:
            detaliu += "  HTTP %s" % val["cod"]
        A("  [%s] %-22s %-24s %s" % (mark, nume, detaliu, sursa_scurta(s, 40)))
        if val.get("nota"):
            A("        nota: %s" % val["nota"])
        if s.get("motiv"):
            A("        motiv: %s" % s["motiv"])
    A("")

    # ---------------------------------------------------------- resurse
    A("RESURSE")
    r = cens["resurse"]
    if "ram_pct" in r:
        A(linie("RAM", r["ram_pct"], "%%  (%s / %s MB)"
                % (v(r["ram_folosit_mb"]), v(r["ram_total_mb"]))))
    if "disc_pct" in r:
        A(linie("Disc", r["disc_pct"], "%%  (%s / %s GB)"
                % (v(r["disc_folosit_gb"]), v(r["disc_total_gb"]))))
    A(linie("Uptime", r.get("uptime", {})))
    A(linie("Încărcare", r.get("incarcare", {})))
    A("")

    # ---------------------------------------------------------- memorie
    A("MEMORIE RONOR")
    mm = cens["memorie"]
    if "stats" in mm:
        A("  NEVERIFICAT — %s" % mm["stats"].get("motiv"))
    else:
        A(linie("Colecție", mm["colectie"]))
        A(linie("Memorii", mm["memorii"]))
        A(linie("Stare Qdrant", mm["stare_qdrant"]))
        A(linie("Vectori indexați", mm["vectori_indexati"]))
    A("")

    # ---------------------------------------------------------- declarativ
    A("SUVERANITATE DECLARATIVĂ")
    d = cens["declarativ"]
    A(linie("Declarate", d["declarate"]))
    A(linie("Conforme", d["conforme"], "  (proiect compose + unless-stopped)"))
    for x in v(d["detaliu"], []) or []:
        if not x["conform"]:
            A("      ! %s — proiect=%s repornire=%s"
              % (x["nume"], x["proiect_compose"], x["repornire"]))
    if v(d["absente"], []):
        A("      absente: %s" % ", ".join(v(d["absente"])))
    A("")

    # ---------------------------------------------------------- inima
    A("BĂTAIA DE INIMĂ A RAPORTORULUI")
    A(linie("Rularea anterioară", cens.get("bataie_anterioara", {})))
    A("  Dacă acest raport lipsește două cicluri la rând, raportorul e mort")
    A("  și tăcerea nu mai trebuie confundată cu liniștea.")
    A("")

    if cu_provenienta:
        A("-" * 46)
        A("PROVENIENȚĂ: ✓ măsurat direct · ≈ derivat din măsurători ·")
        A("? neverificat, cu motivul declarat. Nicio cifră din acest raport")
        A("nu este estimată. Ce nu s-a putut măsura apare marcat, nu omis.")
        A("Regim: %s" % cens.get("regim", "?"))
    return "\n".join(L)


if __name__ == "__main__":
    cale = None
    tip = "CBD"
    for i, a in enumerate(sys.argv):
        if a == "-c" and i + 1 < len(sys.argv):
            cale = sys.argv[i + 1]
        if a == "-t" and i + 1 < len(sys.argv):
            tip = sys.argv[i + 1]
    if cale:
        with open(cale, encoding="utf-8") as f:
            cens = json.load(f)
    else:
        cens = json.load(sys.stdin)
    print(randeaza(cens, tip))
