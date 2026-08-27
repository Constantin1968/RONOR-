#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Colector unic de cens pentru RONOR.

Principiu: cine masoara nu formateaza. Produce un singur cens JSON in care
FIECARE valoare poarta trei campuri de provenienta:
  sursa     - comanda sau ruta care a produs-o
  la        - momentul masuratorii
  incredere - verificat | derivat | neverificat
Ce nu se poate masura nu se inventeaza si nu se omite: apare ca neverificat,
cu motiv.
"""
import json
import os
import socket
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=3))  # EEST
AICI = os.path.dirname(os.path.abspath(__file__))
INVENTAR = os.path.join(AICI, "inventar.json")

VERIFICAT = "verificat"
DERIVAT = "derivat"
NEVERIFICAT = "neverificat"


def acum():
    return datetime.now(TZ).isoformat(timespec="seconds")


def m(valoare, sursa, incredere=VERIFICAT, motiv=None):
    """Construieste o masuratoare cu provenienta."""
    d = {"valoare": valoare, "sursa": sursa, "la": acum(), "incredere": incredere}
    if motiv:
        d["motiv"] = motiv
    return d


def neverif(sursa, motiv):
    return {"valoare": None, "sursa": sursa, "la": acum(),
            "incredere": NEVERIFICAT, "motiv": motiv}


def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True,
                           text=True, timeout=timeout)
        return r.returncode == 0, (r.stdout or r.stderr).strip()
    except Exception as e:
        return False, "EROARE: %s" % e


def http(url, timeout=8, antet=None):
    """Returneaza (cod, corp_text) sau (None, motiv)."""
    try:
        req = urllib.request.Request(url, headers=antet or {})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.getcode(), r.read(4096).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return None, str(e)[:120]


# ---------------------------------------------------------------- inventar

def citeste_inventar():
    with open(INVENTAR, encoding="utf-8") as f:
        return json.load(f)


def e_deliberat(nume, inv):
    od = inv["oprite_deliberat"]
    if nume in od["nume"]:
        return od["motive"].get(nume, "declarat oprit deliberat")
    for s in od["sufixe"]:
        if nume.endswith(s):
            return od["motive"].get(s, "sufix declarat: %s" % s)
    for p in od.get("prefixe_nume", []):
        # prefixul apare dupa numele serviciului: ronor-governance-pre-...
        if ("-" + p) in nume:
            return od["motive"].get(p, "prefix declarat: %s" % p)
    return None


# ---------------------------------------------------------------- containere

def containere(inv):
    """Numara pe stare STRUCTURALA, nu pe text. Distinge fara verificare
    de sanatate de sanatos: sunt lucruri diferite."""
    sursa = "docker ps -aq + docker inspect"
    ok, out = sh("docker ps -aq")
    if not ok:
        return {"eroare": neverif(sursa, "docker ps a esuat: %s" % out[:80])}
    ids = [x for x in out.splitlines() if x.strip()]
    if not ids:
        return {"eroare": neverif(sursa, "niciun container returnat")}

    fmt = ("{{.Name}}|{{.State.Status}}|"
           "{{if .State.Health}}{{.State.Health.Status}}{{else}}FARA{{end}}|"
           "{{.State.ExitCode}}|{{.HostConfig.RestartPolicy.Name}}")
    ok, out = sh("docker inspect -f '%s' %s" % (fmt, " ".join(ids)), timeout=90)
    if not ok:
        return {"eroare": neverif(sursa, "docker inspect a esuat: %s" % out[:80])}

    total = 0
    ruleaza = sanatos = fara_sonda = nesanatos = pornire = 0
    oprite_neasteptat, oprite_deliberat, fara_repornire = [], [], []
    # Containere pentru care inventarul declara o sonda proprie: absenta unui
    # healthcheck Docker nu mai e o necunoscuta, pentru ca le masuram noi.
    cu_sonda_declarata = set(x["nume"] for x in inv.get("servicii_critice", []))
    fara_sonda_neacoperite = []
    # Sarcini care se termina intentionat: pentru ele restart "no" e corect.
    sarcini_efemere = set(inv.get("oprite_deliberat", {}).get("sarcini_efemere", []))
    for line in out.splitlines():
        p = line.strip().strip("'").split("|")
        if len(p) < 5:
            continue
        nume, stare, san, cod, pol = p[0].lstrip("/"), p[1], p[2], p[3], p[4]
        total += 1
        if stare == "running":
            ruleaza += 1
            if san == "healthy":
                sanatos += 1
            elif san == "FARA":
                fara_sonda += 1
                if nume not in cu_sonda_declarata:
                    fara_sonda_neacoperite.append(nume)
            elif san == "starting":
                pornire += 1
            else:
                nesanatos += 1
                oprite_neasteptat.append("%s: sanatate %s" % (nume, san))
            if pol in ("no", "") and nume not in sarcini_efemere:
                fara_repornire.append(nume)
        else:
            motiv = e_deliberat(nume, inv)
            if motiv:
                oprite_deliberat.append({"nume": nume, "motiv": motiv, "cod": cod})
            else:
                oprite_neasteptat.append("%s: %s (cod %s)" % (nume, stare, cod))

    return {
        "total": m(total, sursa),
        "ruleaza": m(ruleaza, sursa),
        "sanatos": m(sanatos, sursa),
        "fara_verificare_sanatate": m(fara_sonda, sursa, VERIFICAT,
                                      "fara healthcheck nu inseamna sanatos"),
        "fara_sonda_neacoperite": m(fara_sonda_neacoperite,
                                    sursa + " + inventar.json", DERIVAT,
                                    "fara healthcheck Docker SI fara sonda "
                                    "declarata: singurele cu stare necunoscuta"),
        "in_pornire": m(pornire, sursa),
        "nesanatos": m(nesanatos, sursa),
        "oprite_deliberat": m(oprite_deliberat, sursa + " + inventar.json", DERIVAT,
                              "clasificare pe baza inventarului declarat"),
        "oprite_neasteptat": m(oprite_neasteptat, sursa + " + inventar.json", DERIVAT,
                               "tot ce nu e declarat deliberat"),
        "fara_politica_repornire": m(fara_repornire, sursa, VERIFICAT,
                                     "nu supravietuiesc repornirii gazdei"),
    }


# ---------------------------------------------------------------- servicii

# Tipurile de sonda implementate mai jos. Lista e explicita ca sa nu existe
# o cale implicita de rezerva: o greseala de tipar in inventar.json trebuie
# raportata ca necunoscuta, nu tratata in silentiu ca sonda HTTP.
SONDE = ("container", "exec", "antet", "pagina", "lucrator", "http")


def servicii(inv):
    out = {}
    for s in inv["servicii_critice"]:
        nume = s["nume"]
        tip = s.get("sonda", "container")
        if tip not in SONDE:
            out[nume] = neverif("inventar.json",
                                "tip de sonda necunoscut: %r" % tip)
            out[nume]["valoare"] = {"stare": "NEDETERMINAT", "viu": False}
            continue
        st_ok, st = sh("docker inspect -f "
                       "'{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}"
                       "{{else}}FARA{{end}}' %s 2>/dev/null" % nume)
        st = st.strip().strip("'") if st_ok else "ABSENT"
        stare_cont = st.split("|")[0] if "|" in st else st

        if tip == "container":
            viu = stare_cont == "running"
            out[nume] = m({"stare": st, "viu": viu},
                          "docker inspect %s" % nume,
                          VERIFICAT if st_ok else NEVERIFICAT,
                          None if st_ok else "containerul nu exista")
            continue

        if tip == "exec":
            # Sonda din interiorul containerului: pg_isready, redis-cli ping.
            cmd = s["comanda"]
            ok, ies = sh("docker exec %s %s 2>&1" % (nume, cmd))
            astept = s.get("asteptat_text", "")
            viu = ok and (astept in ies)
            out[nume] = m({"stare": st, "viu": viu,
                           "raspuns": ies.strip()[:90]},
                          "docker exec %s %s" % (nume, cmd),
                          VERIFICAT,
                          None if viu else "raspunsul nu contine %r" % astept)
            continue

        if tip == "antet":
            # Sonda HTTP cu antet de autentificare luat din mediu.
            cheie_env = s.get("cheie_din_mediu", "")
            val = os.environ.get(cheie_env, "")
            if not val:
                out[nume] = neverif("GET %s" % s["url"],
                                    "lipseste %s in mediu" % cheie_env)
                out[nume]["valoare"] = {"stare": st, "viu": False}
                continue
            cod, corp = http(s["url"],
                             antet={s.get("nume_antet", "api-key"): val})
            viu = (cod == s.get("asteptat_cod", 200))
            det = {"stare": st, "cod": cod, "viu": viu,
                   "raspuns": (corp or "")[:90].replace("\n", " ")}
            ct = s.get("asteptat_text")
            if ct:
                are = ct in (corp or "")
                det["text_%s" % ct] = are
                det["viu"] = viu = viu and are
            out[nume] = m(det, "GET %s (cu antet)" % s["url"], VERIFICAT,
                          None if viu else "sonda nu confirma sanatatea")
            continue

        if tip == "pagina":
            # Interfata web: dovada e pagina servita cu un marcaj al ei,
            # nu doar codul 200. Nu pretindem ca API-ul din spate e sanatos.
            cod, corp = http(s["url"])
            ct = s.get("asteptat_text", "")
            viu = (cod == s.get("asteptat_cod", 200)) and (ct in (corp or ""))
            out[nume] = m({"stare": st, "cod": cod, "viu": viu,
                           "marcaj_gasit": ct in (corp or "")},
                          "GET %s (marcaj: %r)" % (s["url"], ct), VERIFICAT,
                          s.get("nota") if viu else
                          "pagina nu contine marcajul declarat")
            continue

        if tip == "lucrator":
            # Serviciu fara server HTTP: dovada e procesul viu plus jurnal
            # recent. Nu pretindem mai mult decat masuram.
            viu = stare_cont == "running"
            ok2, ies = sh("docker logs --tail 1 --timestamps %s 2>&1" % nume)
            det = {"stare": st, "viu": viu,
                   "ultima_linie_jurnal": ies.strip()[:110]}
            out[nume] = m(det, "docker inspect + docker logs --tail 1 %s" % nume,
                          VERIFICAT if viu else NEVERIFICAT,
                          s.get("nota"))
            continue

        # tip == "http": sonda HTTP simpla, fara autentificare.
        url = s["url"]
        cod, corp = http(url)
        if cod is None:
            out[nume] = neverif("GET %s" % url, "sonda a esuat: %s" % corp)
            out[nume]["valoare"] = {"stare": st, "viu": False}
            continue

        viu = (cod == s.get("asteptat_cod", 200))
        detaliu = {"stare": st, "cod": cod}
        cheie = s.get("asteptat_cheie")
        if cheie:
            # Control impotriva paginii SPA: cerem cheia in JSON, nu doar 200.
            try:
                j = json.loads(corp)
                are = cheie in j
                detaliu["cheie_%s" % cheie] = are
                detaliu["raspuns"] = str(j)[:120]
                viu = viu and are
            except Exception:
                detaliu["json"] = False
                detaliu["raspuns"] = corp[:80].replace("\n", " ")
                viu = False
                detaliu["nota"] = ("cod %s dar corpul nu e JSON: 200 de la un "
                                   "catch-all SPA nu dovedeste sanatate" % cod)
        detaliu["viu"] = viu
        out[nume] = m(detaliu, "GET %s" % url, VERIFICAT)
    return out


# ---------------------------------------------------------------- resurse

def resurse():
    r = {}
    ok, out = sh("free -m | awk '/^Mem:/{print $2\" \"$3\" \"$7}'")
    if ok and len(out.split()) >= 3:
        t, u, a = (int(x) for x in out.split()[:3])
        r["ram_total_mb"] = m(t, "free -m")
        r["ram_folosit_mb"] = m(u, "free -m")
        r["ram_pct"] = m(round(100.0 * u / t, 1), "free -m", DERIVAT, "folosit/total")
    else:
        r["ram"] = neverif("free -m", "iesire neasteptata")

    ok, out = sh("df -B1 / | awk 'NR==2{print $2\" \"$3\" \"$5}'")
    if ok and len(out.split()) >= 3:
        p = out.split()
        t, u = int(p[0]), int(p[1])
        r["disc_total_gb"] = m(round(t / 1e9), "df -B1 /")
        r["disc_folosit_gb"] = m(round(u / 1e9), "df -B1 /")
        r["disc_pct"] = m(int(p[2].rstrip("%")), "df -B1 / (coloana Use%)")
    else:
        r["disc"] = neverif("df -B1 /", "iesire neasteptata")

    ok, out = sh("uptime -p")
    r["uptime"] = m(out, "uptime -p") if ok else neverif("uptime -p", out[:60])
    ok, out = sh("uptime | sed 's/.*load average: //'")
    r["incarcare"] = m(out, "uptime") if ok else neverif("uptime", "esec")
    return r


# ---------------------------------------------------------------- memorie

def memorie():
    cheie = os.environ.get("RMEMORY_API_KEY", "")
    url = os.environ.get("RMEMORY_URL", "http://127.0.0.1:8101") + "/stats"
    if not cheie:
        return {"stats": neverif("GET %s" % url,
                                 "RMEMORY_API_KEY absent din mediu")}
    cod, corp = http(url, antet={"X-API-Key": cheie})
    if cod != 200:
        return {"stats": neverif("GET %s" % url, "cod %s" % cod)}
    try:
        j = json.loads(corp)
    except Exception:
        return {"stats": neverif("GET %s" % url, "raspuns non-JSON")}
    return {
        "colectie": m(j.get("collection"), "GET %s" % url),
        "memorii": m(j.get("points_count"), "GET %s" % url),
        "stare_qdrant": m(j.get("status"), "GET %s" % url),
        "vectori_indexati": m(j.get("indexed_vectors_count"), "GET %s" % url),
    }


# ---------------------------------------------------------------- declarativ

def declarativ(inv):
    """Cate dintre serviciile declarate sunt chiar declarative si supravietuiesc
    repornirii. Afirmatia 'sunt declarative' se dovedeste, nu se presupune."""
    rez, lipsa = [], []
    for nume in inv["servicii_declarative"]:
        ok, out = sh("docker inspect -f "
                     "'{{index .Config.Labels \"com.docker.compose.project\"}}|"
                     "{{.HostConfig.RestartPolicy.Name}}' %s 2>/dev/null" % nume)
        if not ok:
            lipsa.append(nume)
            continue
        p = out.strip().strip("'").split("|")
        proiect = p[0] if p and p[0] not in ("", "<no value>") else None
        pol = p[1] if len(p) > 1 else "?"
        rez.append({"nume": nume, "proiect_compose": proiect, "repornire": pol,
                    "conform": bool(proiect) and pol == "unless-stopped"})
    conforme = sum(1 for x in rez if x["conform"])
    return {
        "declarate": m(len(inv["servicii_declarative"]), "inventar.json"),
        "conforme": m(conforme, "docker inspect etichete compose + politica", DERIVAT,
                      "conform = are proiect compose SI repornire unless-stopped"),
        "detaliu": m(rez, "docker inspect", VERIFICAT),
        "absente": m(lipsa, "docker inspect", VERIFICAT) if lipsa else m([], "docker inspect"),
    }


# ---------------------------------------------------------------- verdict

def verdict(cens, inv):
    """Verdict derivat, cu coduri de motiv. Trei grade, nu doua.
    Nimic oprit deliberat nu produce vreodata degradare."""
    coduri = []
    grad = "NOMINAL"

    c = cens["containere"]
    if "eroare" in c:
        return {"grad": m("NEVERIFICABIL", "derivat", DERIVAT),
                "coduri": m([{"cod": "CENS-INDISPONIBIL",
                              "text": c["eroare"]["motiv"]}], "derivat", DERIVAT)}

    for s in c["oprite_neasteptat"]["valoare"]:
        coduri.append({"cod": "CONT-OPRIT", "text": s, "greutate": "degradat"})
    if c["nesanatos"]["valoare"]:
        coduri.append({"cod": "CONT-NESANATOS",
                       "text": "%d containere nesanatoase" % c["nesanatos"]["valoare"],
                       "greutate": "degradat"})
    if c.get("fara_sonda_neacoperite", {}).get("valoare"):
        coduri.append({"cod": "FARA-SONDA",
                       "text": "%d containere nu au verificare de sanatate; "
                               "starea lor reala e necunoscuta"
                               % len(c["fara_sonda_neacoperite"]["valoare"]),
                       "greutate": "atentie"})
    if c["fara_politica_repornire"]["valoare"]:
        coduri.append({"cod": "FARA-REPORNIRE",
                       "text": "nu supravietuiesc repornirii: %s"
                               % ", ".join(c["fara_politica_repornire"]["valoare"][:6]),
                       "greutate": "atentie"})

    for nume, s in cens["servicii"].items():
        v = s.get("valoare") or {}
        if s["incredere"] == NEVERIFICAT:
            coduri.append({"cod": "SVC-NEVERIFICAT",
                           "text": "%s: %s" % (nume, s.get("motiv", "")),
                           "greutate": "atentie"})
        elif not v.get("viu"):
            coduri.append({"cod": "SVC-CAZUT",
                           "text": "%s: %s" % (nume, v.get("nota") or v.get("stare")),
                           "greutate": "degradat"})

    pr = inv["praguri"]
    r = cens["resurse"]
    if "disc_pct" in r and r["disc_pct"]["valoare"] is not None:
        d = r["disc_pct"]["valoare"]
        if d >= pr["disc_degradat_pct"]:
            coduri.append({"cod": "DISC-CRITIC", "text": "disc %d%%" % d,
                           "greutate": "degradat"})
        elif d >= pr["disc_atentie_pct"]:
            coduri.append({"cod": "DISC-RIDICAT", "text": "disc %d%%" % d,
                           "greutate": "atentie"})
    if "ram_pct" in r and r["ram_pct"]["valoare"] is not None:
        if r["ram_pct"]["valoare"] >= pr["ram_atentie_pct"]:
            coduri.append({"cod": "RAM-RIDICAT",
                           "text": "RAM %.1f%%" % r["ram_pct"]["valoare"],
                           "greutate": "atentie"})

    dcl = cens["declarativ"]
    if dcl["conforme"]["valoare"] < dcl["declarate"]["valoare"]:
        coduri.append({"cod": "DECL-INCOMPLET",
                       "text": "%d din %d servicii declarate sunt conforme"
                               % (dcl["conforme"]["valoare"], dcl["declarate"]["valoare"]),
                       "greutate": "atentie"})

    if any(x["greutate"] == "degradat" for x in coduri):
        grad = "DEGRADAT"
    elif any(x["greutate"] == "atentie" for x in coduri):
        grad = "ATENTIE"

    return {"grad": m(grad, "derivat din codurile de motiv", DERIVAT,
                      "DEGRADAT doar la serviciu critic cazut sau container "
                      "oprit nedeclarat; nimic deliberat nu degradeaza"),
            "coduri": m(coduri, "derivat", DERIVAT)}


# ---------------------------------------------------------------- inima

def bataie(inv, cens):
    f = inv["batai_de_inima"]["fisier"]
    try:
        os.makedirs(os.path.dirname(f), exist_ok=True)
        with open(f, "a", encoding="utf-8") as h:
            h.write("%s %s\n" % (acum(), cens["verdict"]["grad"]["valoare"]))
        return m(True, "append %s" % f)
    except Exception as e:
        return neverif("append %s" % f, str(e)[:80])


def ultima_bataie(inv):
    f = inv["batai_de_inima"]["fisier"]
    if not os.path.exists(f):
        return neverif("citire %s" % f, "fisier inexistent: prima rulare")
    try:
        with open(f, encoding="utf-8") as h:
            linii = [x for x in h.read().splitlines() if x.strip()]
        return m(linii[-1] if linii else None, "citire %s" % f)
    except Exception as e:
        return neverif("citire %s" % f, str(e)[:80])


# ---------------------------------------------------------------- main

def construieste(sec=False):
    inv = citeste_inventar()
    cens = {
        "schema": "ronor.cens/1",
        "generat_la": acum(),
        "nod": socket.gethostname(),
        "regim": "sec" if sec else "normal",
        "inventar_actualizat": inv.get("actualizat"),
        "containere": containere(inv),
        "servicii": servicii(inv),
        "resurse": resurse(),
        "memorie": memorie(),
        "declarativ": declarativ(inv),
    }
    cens["verdict"] = verdict(cens, inv)
    cens["bataie_anterioara"] = ultima_bataie(inv)
    if not sec:
        cens["bataie"] = bataie(inv, cens)
    return cens


if __name__ == "__main__":
    sec = "--sec" in sys.argv
    c = construieste(sec=sec)
    dest = None
    for i, a in enumerate(sys.argv):
        if a == "-o" and i + 1 < len(sys.argv):
            dest = sys.argv[i + 1]
    text = json.dumps(c, ensure_ascii=False, indent=2)
    if dest:
        with open(dest, "w", encoding="utf-8") as f:
            f.write(text)
        print("cens scris in %s (%d octeti), verdict %s"
              % (dest, len(text), c["verdict"]["grad"]["valoare"]))
    else:
        print(text)
