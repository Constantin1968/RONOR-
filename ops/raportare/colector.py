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
import ipaddress
import json
import os
import re
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


# ---------------------------------------------------------------- expunere

# Masuratorile de suprafata de expunere implementate mai jos. Lista e
# explicita din acelasi motiv ca SONDE: o cheie declarata in inventar si
# neimplementata aici trebuie sa apara ca neverificata, nu sa dispara.
EXPUNERE = ("porturi_publice", "porturi_neasteptate", "autentificare_parola",
            "conturi_atacabile", "protectie_ghicire", "tentative",
            "tailscale_ssh", "intrari_reusite_necunoscute")


def _sshd_config():
    """Configuratia efectiva a sshd, nu fisierul de pe disc."""
    ok, out = sh("sshd -T 2>/dev/null")
    if not ok or not out:
        return None
    cfg = {}
    for line in out.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2:
            cheie, val = parts[0].lower(), parts[1].strip()
            if cheie in cfg:
                cfg[cheie] = cfg[cheie] + " " + val
            else:
                cfg[cheie] = val
    return cfg


def _cunoscuta(adresa, retele):
    """Adresa sursa aparține unei retele declarate cunoscute?"""
    try:
        ip = ipaddress.ip_address(adresa)
    except ValueError:
        return None  # nu e adresa IP: nu se poate decide, nu se ghiceste
    for r in retele:
        try:
            if ip in ipaddress.ip_network(r, strict=False):
                return True
        except ValueError:
            continue
    return False


def _porturi_publice(asteptate, procese=()):
    """Socketuri care ascultă pe altceva decât bucla locală."""
    sursa = "ss -lntpH"
    ok, out = sh("ss -lntpH")
    if not ok:
        return neverif(sursa, "ss a esuat: %s" % out[:80]), None
    publice, neasteptate = [], []
    for line in out.splitlines():
        camp = line.split()
        if len(camp) < 4:
            continue
        local = camp[3]
        adr, _, port = local.rpartition(":")
        adr = adr.strip("[]")
        if adr in ("127.0.0.1", "::1") or adr.startswith("127."):
            continue
        proc = ""
        mp = re.search(r'"([^"]+)"', line)
        if mp:
            proc = mp.group(1)
        intrare = "%s/%s" % (port, proc or "?")
        if intrare not in publice:
            publice.append(intrare)
        if proc in procese:
            continue  # port efemer al unui proces declarat: numarul variaza
        try:
            if int(port) not in asteptate:
                neasteptate.append(intrare)
        except ValueError:
            neasteptate.append(intrare)
    return (m(sorted(publice), sursa, VERIFICAT,
              "ascultă pe interfata publica, nu doar pe bucla locala"),
            sorted(set(neasteptate)))


def _conturi_atacabile(cfg):
    """Conturi care pot fi ghicite prin parola de la distanta.

    Nu se emite niciodata conținutul sau forma hashului: doar numele
    contului si faptul ca parola e utilizabila."""
    sursa = "/etc/shadow + sshd -T (allowusers, permitrootlogin)"
    if cfg is None:
        return neverif(sursa, "sshd -T indisponibil")
    ok, out = sh("awk -F: 'length($2) > 3 && $2 !~ /^[!*]/ {print $1}' /etc/shadow")
    if not ok:
        return neverif(sursa, "citirea /etc/shadow a esuat")
    cu_parola = [x.strip() for x in out.splitlines() if x.strip()]
    permise = cfg.get("allowusers", "").split()
    if permise:
        cu_parola = [u for u in cu_parola if u in permise]
    # root cu chei obligatorii nu e atacabil prin parola, oricat de puternica.
    if cfg.get("permitrootlogin", "") in ("without-password", "prohibit-password",
                                          "no", "forced-commands-only"):
        cu_parola = [u for u in cu_parola if u != "root"]
    if cfg.get("passwordauthentication", "") != "yes":
        cu_parola = []
    return m(sorted(cu_parola), sursa, DERIVAT,
             "parola utilizabila SI permis in allowusers SI autentificare cu "
             "parola activa; numele contului, niciodata hashul")


def _protectie_ghicire():
    sursa = "systemctl is-active + command -v + ufw status"
    f2b = sh("systemctl is-active fail2ban")[1].strip()
    sg = sh("systemctl is-active sshguard")[1].strip()
    ok_ufw, ufw = sh("ufw status")
    limite = 0
    if ok_ufw:
        limite = sum(1 for l in ufw.splitlines() if "LIMIT" in l)
    activa = (f2b == "active") or (sg == "active") or limite > 0
    return m({"fail2ban": f2b, "sshguard": sg, "reguli_limitare": limite,
              "activa": activa}, sursa, VERIFICAT,
             None if activa else "nicio protectie impotriva ghicirii repetate")


def _tentative(jurnal, stare_veche):
    sursa = "grep -c pe %s" % jurnal
    if not os.path.exists(jurnal):
        return neverif(sursa, "jurnalul de autentificare nu exista: %s" % jurnal)
    esuate = invalide = acceptate = 0
    try:
        with open(jurnal, encoding="utf-8", errors="replace") as f:
            for line in f:
                if "Failed password" in line:
                    esuate += 1
                if "Invalid user" in line:
                    invalide += 1
                if "Accepted " in line:
                    acceptate += 1
    except Exception as e:
        return neverif(sursa, str(e)[:80])
    det = {"esuate": esuate, "utilizator_inexistent": invalide,
           "acceptate_sshd": acceptate}
    v_veche = (stare_veche or {}).get("esuate")
    if isinstance(v_veche, int):
        # Jurnalul se roteste: o scadere nu e o scadere reala a atacurilor.
        det["delta"] = esuate - v_veche if esuate >= v_veche else None
        if det["delta"] is None:
            det["nota"] = "jurnal rotit intre rapoarte: delta nu e comparabila"
    return m(det, sursa, VERIFICAT,
             "acceptate_sshd numara doar sshd; Tailscale SSH nu trece prin el")


def _tailscale_ssh():
    sursa = "tailscale debug prefs"
    ok, out = sh("tailscale debug prefs 2>/dev/null")
    if not ok or not out:
        return neverif(sursa, "tailscale indisponibil sau fara permisiune")
    mm = re.search(r'"RunSSH":\s*(true|false)', out)
    if not mm:
        return neverif(sursa, "cheia RunSSH absenta din preferinte")
    activ = mm.group(1) == "true"
    return m(activ, sursa, VERIFICAT,
             "activ: accesul la shell e decis de regulile Tailscale, nu de "
             "authorized_keys de pe gazda" if activ else None)


# Zilele saptamanii in ieșirea lui `last`. O linie de consola locala nu are
# gazda, asa ca al treilea camp e data: fara verificarea asta, "Thu" ar fi
# raportat ca sursa nedecidabila, adica un fals semnal la fiecare raport.
_ZILE_LAST = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")


def _recunoscute(d):
    """Registrul de intrari analizate si rezolvate.

    O intrare din wtmp nu dispare cand cauza ei e reparata: wtmp e o arhiva,
    nu o stare. Fara registru, un eveniment rezolvat ar degrada fiecare raport
    pana iese singur din fereastra, iar un semnal care ramane aprins dupa
    reparatie isi pierde intelesul -- si pe urma il pierd si celelalte.

    Registrul nu ascunde nimic: intrarea recunoscuta apare in raport, cu
    motivul si cu termenul ei. Recunoasterea fara motiv, fara termen, sau cu
    termen trecut nu se aplica: altfel registrul devine o legatura la ochi
    permanenta, adica exact ce ar trebui sa impiedice."""
    brut = d.get("intrari_recunoscute")
    if not isinstance(brut, list):
        return {}, []
    azi = datetime.now(timezone.utc).date()
    valide, invalide = {}, []
    for e in brut:
        if not isinstance(e, dict):
            invalide.append("intrare de registru care nu e obiect")
            continue
        cont = str(e.get("cont") or "").strip()
        sursa = str(e.get("sursa") or "").strip()
        motiv = str(e.get("motiv") or "").strip()
        pana = str(e.get("pana_la") or "").strip()
        eticheta = "%s de la %s" % (cont or "?", sursa or "?")
        if not cont or not sursa:
            invalide.append("%s -- lipseste contul sau sursa" % eticheta)
            continue
        if not motiv:
            invalide.append("%s -- recunoastere fara motiv" % eticheta)
            continue
        if not pana:
            invalide.append("%s -- recunoastere fara termen" % eticheta)
            continue
        try:
            termen = datetime.strptime(pana, "%Y-%m-%d").date()
        except ValueError:
            invalide.append("%s -- termen nevalid: %s" % (eticheta, pana))
            continue
        if termen < azi:
            invalide.append("%s -- recunoastere expirata la %s" % (eticheta, pana))
            continue
        valide["%s de la %s" % (cont, sursa)] = {
            "motiv": motiv, "pana_la": pana,
            "recunoscut_la": str(e.get("recunoscut_la") or "").strip() or None,
        }
    return valide, invalide


def _intrari_reusite(retele, recunoscute=None, invalide=None):
    """Autentificari reusite si sursa lor. Acopera si Tailscale SSH, care nu
    scrie in jurnalul sshd dar apare in wtmp."""
    recunoscute = recunoscute or {}
    sursa = "last -F -w -n 200 (wtmp) + Accepted din jurnalul sshd"
    ok, out = sh("last -F -w -n 200")
    if not ok:
        return neverif(sursa, "last a esuat"), None
    necunoscute, nedecidabile, cunoscute = [], [], 0
    explicate = []
    for line in out.splitlines():
        camp = line.split()
        if len(camp) < 3 or camp[0] in ("wtmp", "reboot"):
            continue
        terminal, gazda = camp[1], camp[2]
        # Consola fizica sau linie fara gazda: intrarea e locala, nu remota.
        if gazda in _ZILE_LAST or terminal.startswith("tty") \
                or terminal == "console":
            cunoscute += 1
            continue
        stare = _cunoscuta(gazda, retele)
        if stare is True:
            cunoscute += 1
        elif stare is False:
            intrare = "%s de la %s" % (camp[0], gazda)
            reg = recunoscute.get(intrare)
            if reg is not None:
                if not any(x["intrare"] == intrare for x in explicate):
                    explicate.append(dict(reg, intrare=intrare))
            elif intrare not in necunoscute:
                necunoscute.append(intrare)
        else:
            if gazda not in nedecidabile:
                nedecidabile.append(gazda)
    # O recunoastere care nu se potriveste cu nicio intrare masurata e o
    # ramasita: se raporteaza, ca registrul sa nu creasca nesupravegheat.
    nefolosite = [k for k in recunoscute
                  if not any(x["intrare"] == k for x in explicate)]
    det = {"necunoscute": necunoscute, "cunoscute": cunoscute,
           "sursa_nedecidabila": nedecidabile[:6],
           "recunoscute": explicate,
           "recunoasteri_nefolosite": sorted(nefolosite),
           "recunoasteri_nevalide": list(invalide or [])}
    return m(det, sursa, VERIFICAT,
             "necunoscut = sursa care nu apartine niciunei retele declarate "
             "si nu e recunoscuta in registru"), \
        necunoscute


def _stare_veche(cale):
    if not cale or not os.path.exists(cale):
        return {}
    try:
        with open(cale, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _scrie_stare(cale, tentative):
    if not cale:
        return
    try:
        os.makedirs(os.path.dirname(cale), exist_ok=True)
        val = tentative.get("valoare") or {}
        with open(cale, "w", encoding="utf-8") as f:
            json.dump({"la": acum(), "esuate": val.get("esuate")}, f)
    except Exception:
        pass


def expunere(inv, sec=False):
    """Suprafata de expunere a gazdei. Strict citire: nicio comanda de aici
    nu modifica parafocul, conturile, serviciile sau configuratia sshd."""
    d = inv.get("expunere")
    if not d:
        return {"eroare": neverif("inventar.json",
                                  "blocul 'expunere' nu e declarat in inventar")}
    retele = d.get("retele_cunoscute", [])
    asteptate = set(d.get("porturi_publice_asteptate", []))
    procese = set(d.get("procese_publice_asteptate", []))
    cale_stare = d.get("stare_fisier")
    veche = _stare_veche(cale_stare)

    cfg = _sshd_config()
    porturi, neasteptate = _porturi_publice(asteptate, procese)
    tent = _tentative(d.get("jurnal_autentificare", "/var/log/auth.log"), veche)
    reg, reg_invalide = _recunoscute(d)
    intrari, necunoscute = _intrari_reusite(retele, reg, reg_invalide)

    rez = {
        "porturi_publice": porturi,
        "porturi_neasteptate": m(neasteptate or [],
                                 "ss -lntpH + inventar.json", DERIVAT,
                                 "ascultă public si nu e declarat in inventar")
        if neasteptate is not None else neverif("ss -lntpH", "porturi nemasurate"),
        "autentificare_parola": (
            m({"activa": cfg.get("passwordauthentication") == "yes",
               "root": cfg.get("permitrootlogin", "?"),
               "conturi_permise": cfg.get("allowusers", "(fara restrictie)"),
               "incercari_maxime": cfg.get("maxauthtries", "?")},
              "sshd -T", VERIFICAT)
            if cfg is not None else neverif("sshd -T", "sshd -T indisponibil")),
        "conturi_atacabile": _conturi_atacabile(cfg),
        "protectie_ghicire": _protectie_ghicire(),
        "tentative": tent,
        "tailscale_ssh": _tailscale_ssh(),
        "intrari_reusite_necunoscute": intrari,
    }
    if not sec:
        _scrie_stare(cale_stare, tent)
    # Contractul: cheile emise sunt exact cele declarate implementate.
    for cheie in EXPUNERE:
        if cheie not in rez:
            rez[cheie] = neverif("colector.py",
                                 "masuratoare declarata dar neprodusa")
    return rez


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

    # Expunere. O intrare reusita de la o sursa necunoscuta e singurul motiv
    # de aici care degradeaza: restul sunt riscuri, nu evenimente.
    ex = cens.get("expunere") or {}
    if "eroare" in ex:
        coduri.append({"cod": "EXP-NEDECLARAT",
                       "text": ex["eroare"].get("motiv", "expunere nemasurata"),
                       "greutate": "atentie"})
    else:
        ir = ex.get("intrari_reusite_necunoscute", {})
        if ir.get("incredere") == NEVERIFICAT:
            coduri.append({"cod": "EXP-NEVERIFICAT",
                           "text": "intrarile reusite nu s-au putut masura: %s"
                                   % ir.get("motiv", ""),
                           "greutate": "atentie"})
        else:
            det_ir = ir.get("valoare") or {}
            nec = det_ir.get("necunoscute") or []
            if nec:
                coduri.append({"cod": "EXP-INTRARE-NECUNOSCUTA",
                               "text": "autentificare reusita de la sursa "
                                       "necunoscuta: %s" % "; ".join(nec[:4]),
                               "greutate": "degradat"})
            # O recunoastere care nu se aplica lasa intrarea sa degradeze din
            # nou, deci nu e o scapare silentioasa; totusi se semnaleaza,
            # pentru ca un registru stricat e o problema in sine.
            inv_reg = det_ir.get("recunoasteri_nevalide") or []
            if inv_reg:
                coduri.append({"cod": "EXP-RECUNOASTERE-NEVALIDA",
                               "text": "recunoasteri care nu se aplica: %s"
                                       % "; ".join(inv_reg[:4]),
                               "greutate": "atentie"})
        ca = (ex.get("conturi_atacabile", {}).get("valoare")) or []
        pp = (ex.get("porturi_publice", {}).get("valoare")) or []
        prot = (ex.get("protectie_ghicire", {}).get("valoare")) or {}
        if ca and pp:
            coduri.append({"cod": "EXP-PAROLA-DESCHISA",
                           "text": "conturi ghicibile prin parola de pe "
                                   "internet: %s" % ", ".join(ca),
                           "greutate": "atentie"})
        if pp and prot and not prot.get("activa"):
            coduri.append({"cod": "EXP-FARA-PROTECTIE",
                           "text": "porturi publice fara protectie impotriva "
                                   "ghicirii repetate",
                           "greutate": "atentie"})
        pn = (ex.get("porturi_neasteptate", {}).get("valoare")) or []
        if pn:
            coduri.append({"cod": "EXP-PORT-NEDECLARAT",
                           "text": "ascultă public fara sa fie declarat: %s"
                                   % ", ".join(pn[:6]),
                           "greutate": "atentie"})
        if (ex.get("tailscale_ssh", {}).get("valoare")) is True:
            coduri.append({"cod": "EXP-TAILSCALE-SSH",
                           "text": "Tailscale SSH activ: accesul la shell e "
                                   "decis in afara gazdei, de reguli",
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
        "expunere": expunere(inv, sec=sec),
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
