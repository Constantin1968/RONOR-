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

# Unde apare suprafata de expunere. Tabloul complet doar in raportul care se
# citeste pe indelete; in cel de dimineata o singura linie, pentru ca o
# secțiune lunga la ora aceea se sare, iar un raport pe care nu-l mai citesti
# nu apara nimic. In raportul saptamanal, nimic: acela e despre ce urmeaza,
# nu despre stare, iar a treia copie a acelorasi cifre le slabeste pe toate.
EXPUNERE_COMPLETA = ("CBD", "SANATATE")
EXPUNERE_LINIE = ("OBD",)


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


def numar_necunoscute(cens):
    """Cate autentificari reusite vin de la o sursa necunoscuta. Returneaza
    None daca nu s-a putut masura: zero si nemasurat nu sunt acelasi lucru."""
    ex = cens.get("expunere") or {}
    if "eroare" in ex:
        return None
    ir = ex.get("intrari_reusite_necunoscute")
    if not isinstance(ir, dict) or ir.get("incredere") == "neverificat":
        return None
    return len((ir.get("valoare") or {}).get("necunoscute") or [])


def linie_expunere(cens):
    """Condensatul de dimineata: o singura linie, doar semnalul."""
    n = numar_necunoscute(cens)
    if n is None:
        return "EXPUNERE: nemăsurată — vezi raportul de închidere"
    if n:
        return ("EXPUNERE: %d autentificări reușite de la sursă necunoscută "
                "— de verificat acum" % n)
    ex = cens.get("expunere") or {}
    pp = v(ex.get("porturi_publice", {}), []) or []
    ca = v(ex.get("conturi_atacabile", {}), []) or []
    coada = ""
    if ca:
        coada = "; %d cont(uri) ghicibile prin parolă" % len(ca)
    return ("EXPUNERE: nicio intrare neexplicată; %d port(uri) publice%s"
            % (len(pp), coada))


def sectiune_expunere(ex):
    L = []
    A = L.append
    A("SUPRAFAȚĂ DE EXPUNERE")
    if "eroare" in ex:
        A("  NEMĂSURAT — %s" % ex["eroare"].get("motiv"))
        return L

    ir = ex.get("intrari_reusite_necunoscute", {})
    if ir.get("incredere") == "neverificat":
        A("  Intrări reușite: NEMĂSURAT — %s" % ir.get("motiv"))
    else:
        det = ir.get("valoare") or {}
        nec = det.get("necunoscute") or []
        A("%-46s %s %s"
          % ("  %-17s: %d necunoscute, %d cunoscute"
             % ("Intrări reușite", len(nec), det.get("cunoscute", 0)),
             SEMNE.get(ir.get("incredere", ""), " "), sursa_scurta(ir, 40)))
        for x in nec[:6]:
            A("      ! %s" % x)
        if not nec:
            A("      Nicio autentificare de la o sursă din afara rețelelor")
            A("      declarate cunoscute.")
        if det.get("sursa_nedecidabila"):
            A("      sursă nedecidabilă (nu e adresă IP): %s"
              % ", ".join(det["sursa_nedecidabila"]))

    pp = ex.get("porturi_publice", {})
    lista = v(pp, []) or []
    A("%-46s %s %s" % ("  %-17s: %d" % ("Porturi publice", len(lista)),
                       SEMNE.get(pp.get("incredere", ""), " "),
                       sursa_scurta(pp, 40)))
    if lista:
        A("      " + ", ".join(lista))
    ned = v(ex.get("porturi_neasteptate", {}), []) or []
    if ned:
        A("      ! nedeclarate: %s" % ", ".join(ned))

    ap = ex.get("autentificare_parola", {})
    val = ap.get("valoare")
    if isinstance(val, dict):
        A("%-46s %s %s" % ("  %-17s: %s" % ("Parolă în SSH",
                                            "activă" if val.get("activa")
                                            else "oprită"),
                           SEMNE.get(ap.get("incredere", ""), " "),
                           sursa_scurta(ap, 40)))
        A("      root: %s · conturi permise: %s · încercări maxime: %s"
          % (val.get("root"), val.get("conturi_permise"),
             val.get("incercari_maxime")))
    else:
        A("  Parolă în SSH   : NEMĂSURAT — %s" % ap.get("motiv"))

    ca = ex.get("conturi_atacabile", {})
    lc = v(ca, []) or []
    A("%-46s %s %s" % ("  %-17s: %d" % ("Conturi ghicibile", len(lc)),
                       SEMNE.get(ca.get("incredere", ""), " "),
                       sursa_scurta(ca, 40)))
    if lc:
        A("      ! %s — parolă utilizabilă, permis în SSH, port public"
          % ", ".join(lc))

    pg = ex.get("protectie_ghicire", {})
    vp = pg.get("valoare") or {}
    A("%-46s %s %s" % ("  %-17s: %s" % ("Protecție ghicire",
                                        "da" if vp.get("activa") else "NU"),
                       SEMNE.get(pg.get("incredere", ""), " "),
                       sursa_scurta(pg, 40)))
    A("      fail2ban: %s · sshguard: %s · reguli de limitare: %s"
      % (vp.get("fail2ban", "?"), vp.get("sshguard", "?"),
         vp.get("reguli_limitare", "?")))

    tt = ex.get("tentative", {})
    vt = tt.get("valoare")
    if isinstance(vt, dict):
        d = vt.get("delta")
        sufix = "" if d is None else "  (+%d de la raportul precedent)" % d
        A("%-46s %s %s" % ("  %-17s: %s%s" % ("Tentative eșuate",
                                              vt.get("esuate"), sufix),
                           SEMNE.get(tt.get("incredere", ""), " "),
                           sursa_scurta(tt, 40)))
        A("      cont inexistent: %s · acceptate de sshd: %s"
          % (vt.get("utilizator_inexistent"), vt.get("acceptate_sshd")))
        if vt.get("nota"):
            A("      notă: %s" % vt["nota"])
    else:
        A("  Tentative eșuate : NEMĂSURAT — %s" % tt.get("motiv"))

    ts = ex.get("tailscale_ssh", {})
    if ts.get("incredere") == "neverificat":
        A("  Tailscale SSH   : NEMĂSURAT — %s" % ts.get("motiv"))
    else:
        A("%-46s %s %s" % ("  %-17s: %s" % ("Tailscale SSH",
                                            "activ" if ts.get("valoare")
                                            else "inactiv"),
                           SEMNE.get(ts.get("incredere", ""), " "),
                           sursa_scurta(ts, 40)))
        if ts.get("valoare") and ts.get("motiv"):
            A("      %s" % ts["motiv"])
    A("  Măsurat strict prin citire: raportul nu schimbă nimic din ce observă.")
    return L


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
    A("  nedeclarat, ori autentificare reușită de la o sursă necunoscută.")
    A("  Ce e oprit deliberat nu produce niciodată degradare.")
    A("")

    if tip in EXPUNERE_LINIE:
        A(linie_expunere(cens))
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

    # ---------------------------------------------------------- expunere
    if tip in EXPUNERE_COMPLETA:
        for x in sectiune_expunere(cens.get("expunere") or {}):
            A(x)
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
