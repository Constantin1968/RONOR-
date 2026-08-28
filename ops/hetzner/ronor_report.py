#!/usr/bin/env python3
"""
RONOR — generator de rapoarte periodice (CBD / OBD / TODO)

Ruleaza PE NODUL SUVERAN (Hetzner), nu pe infrastructura Manus.
Livrare dubla: Telegram (@ronor_sovereign_bot) + e-mail via Resend
de pe constantine@ma11ai.com.

Tipuri:
  OBD  — Open Business Day, 07:00 Europe/Bucharest (04:00 UTC)
  CBD  — Close Business Day, 23:45 Europe/Bucharest (20:45 UTC)
  TODO — To-Do General, vineri 17:00 Europe/Bucharest (14:00 UTC)

Principiu canonic: raporteaza doar stare VERIFICATA prin interogare.
Orice lucru neverificabil este declarat explicit ca atare.
"""
import json
import os
import socket
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta

TZ = timezone(timedelta(hours=3))  # EEST in august

BOT_TOKEN = os.environ.get("RONOR_BOT_TOKEN", "")
CHAT_ID = os.environ.get("RONOR_CHAT_ID", "")
RESEND_KEY = os.environ.get("RESEND_API_KEY", "")
MAIL_FROM = os.environ.get("RONOR_MAIL_FROM", "constantine@ma11ai.com")
MAIL_TO = os.environ.get("RONOR_MAIL_TO", "constantine@ma11ai.com")
ARCHIVE = "/opt/ronor/reports"
RMEM_URL = "http://127.0.0.1:8101"
RMEM_KEY = os.environ.get("RMEMORY_API_KEY", "")

# containere oprite intentionat (snapshot-uri pre-upgrade), nu defecte
RESIDUAL_MARKS = ("-pre", "prek9", "-broken-", "_08")


def sh(cmd, timeout=30):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True,
                           text=True, timeout=timeout)
        return r.returncode == 0, (r.stdout or r.stderr).strip()
    except Exception as e:
        return False, f"EROARE: {e}"


def containers():
    ok, out = sh("docker ps -a --format '{{.Names}}\t{{.Status}}'")
    if not ok:
        return None
    total = unhealthy = exited = 0
    problems, residual = [], []
    for line in out.splitlines():
        if "\t" not in line:
            continue
        name, status = line.split("\t", 1)
        total += 1
        low = status.lower()
        if "unhealthy" in low:
            unhealthy += 1
            problems.append(f"{name}: {status}")
        elif "exited" in low or "dead" in low:
            if any(k in name for k in RESIDUAL_MARKS):
                residual.append(f"{name}: {status}")
            else:
                exited += 1
                problems.append(f"{name}: {status}")
    return {"total": total, "unhealthy": unhealthy, "exited": exited,
            "problems": problems, "residual": residual}


def resources():
    res = {}
    ok, out = sh("free -g | awk '/^Mem:/{print $2\" \"$3\" \"$7}'")
    if ok and out:
        p = out.split()
        if len(p) >= 3:
            res["ram_total"], res["ram_used"], res["ram_avail"] = p[0], p[1], p[2]
    ok, out = sh("df -h / | awk 'NR==2{print $2\" \"$3\" \"$5}'")
    if ok and out:
        p = out.split()
        if len(p) >= 3:
            res["disk_total"], res["disk_used"], res["disk_pct"] = p[0], p[1], p[2]
    ok, out = sh("uptime -p")
    if ok:
        res["uptime"] = out
    return res


def critical_services():
    want = ["ronor-governance", "ronor-r-memory", "ronor-telegram-gov",
            "ronor-qdrant-tls", "ronor-n8n"]
    out = {}
    for svc in want:
        fmt = ("{{.State.Status}}{{if .State.Health}}"
               "/{{.State.Health.Status}}{{end}}")
        ok, st = sh(f"docker inspect -f '{fmt}' {svc} 2>/dev/null")
        out[svc] = st if ok and st else "ABSENT"
    return out


def rmemory_stats():
    if not RMEM_KEY:
        return {"eroare": "RMEMORY_API_KEY absent"}
    try:
        req = urllib.request.Request(f"{RMEM_URL}/stats",
                                     headers={"X-API-Key": RMEM_KEY})
        return json.load(urllib.request.urlopen(req, timeout=15))
    except Exception as e:
        return {"eroare": str(e)[:80]}


def operators_state():
    base = "/opt/ronor/operators"
    if not os.path.exists(os.path.join(base, "registry.py")):
        return {"stare": "cadru absent"}
    code = ("import registry as r;"
            "print('operatori', len(r.REGISTRY));"
            "print('actiuni', sum(len(o.actions) for o in r.REGISTRY.values()))")
    ok, out = sh(f'cd {base} && python3 -c "{code}" 2>&1', timeout=45)
    if not ok:
        return {"stare": "neverificabil", "detaliu": out[:100]}
    d = {}
    for line in out.splitlines():
        p = line.split()
        if len(p) == 2:
            d[p[0]] = p[1]
    return d or {"stare": "fara ieșire", "detaliu": out[:80]}


def dmarc_policy(domains=("ronor.tech", "ma11ai.com")):
    out = {}
    for d in domains:
        try:
            u = f"https://dns.google/resolve?name=_dmarc.{d}&type=TXT"
            req = urllib.request.Request(u, headers={"User-Agent": "RONOR/1.0"})
            j = json.load(urllib.request.urlopen(req, timeout=15))
            txt = ""
            for a in j.get("Answer", []):
                if a.get("type") == 16 and "DMARC1" in a.get("data", ""):
                    txt = a["data"].strip('"')
            pol = pct = "?"
            for tok in txt.split(";"):
                tok = tok.strip()
                if tok.startswith("p="):
                    pol = tok[2:]
                elif tok.startswith("pct="):
                    pct = tok[4:]
            out[d] = f"p={pol} pct={pct}"
        except Exception as e:
            out[d] = f"EROARE: {str(e)[:40]}"
    return out


def send_telegram(text):
    if not BOT_TOKEN or not CHAT_ID:
        return False, "credentiale Telegram absente"
    chunks, cur = [], ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > 3900:
            chunks.append(cur)
            cur = line
        else:
            cur = f"{cur}\n{line}" if cur else line
    if cur:
        chunks.append(cur)
    sent = 0
    for i, ch in enumerate(chunks):
        prefix = f"({i+1}/{len(chunks)})\n" if len(chunks) > 1 else ""
        data = urllib.parse.urlencode(
            {"chat_id": CHAT_ID, "text": prefix + ch}).encode()
        try:
            u = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
            urllib.request.urlopen(
                urllib.request.Request(u, data=data), timeout=25)
            sent += 1
        except Exception as e:
            return False, f"{sent}/{len(chunks)}: {str(e)[:60]}"
    return True, f"{sent}/{len(chunks)} fragmente"


def send_email(subject, text):
    """Livrare prin Resend de pe constantine@ma11ai.com (domeniu verificat)."""
    if not RESEND_KEY:
        return False, "RESEND_API_KEY absent"
    body = json.dumps({
        "from": f"RONOR Control <{MAIL_FROM}>",
        "to": [MAIL_TO],
        "subject": subject,
        "text": text,
    }).encode()
    try:
        req = urllib.request.Request(
            "https://api.resend.com/emails", data=body,
            headers={"Authorization": f"Bearer {RESEND_KEY}",
                     "Content-Type": "application/json",
                     "User-Agent": "RONOR/1.0"})
        r = json.load(urllib.request.urlopen(req, timeout=30))
        return True, r.get("id", "trimis")
    except Exception as e:
        detail = ""
        if hasattr(e, "read"):
            try:
                detail = e.read().decode()[:120]
            except Exception:
                pass
        return False, f"{str(e)[:60]} {detail}"


def build(kind):
    now = datetime.now(TZ)
    zi = ["luni", "marți", "miercuri", "joi", "vineri",
          "sâmbătă", "duminică"][now.weekday()]
    L = []
    A = L.append

    titles = {"OBD": "RONOR — OPEN BUSINESS DAY",
              "CBD": "RONOR — CLOSE BUSINESS DAY",
              "TODO": "RONOR — TO-DO GENERAL (săptămânal)"}
    A(titles.get(kind, "RONOR — RAPORT"))
    A("=" * 36)
    A(f"{zi} {now.strftime('%d.%m.%Y %H:%M')} EEST")
    A(f"Nod: {socket.gethostname()}")
    A("")

    c, r = containers(), resources()
    A("INFRASTRUCTURĂ (măsurat)")
    if c:
        stare = "NOMINAL" if c["unhealthy"] == 0 and c["exited"] == 0 \
                else "DEGRADAT"
        A(f"  Stare generală : {stare}")
        A(f"  Containere     : {c['total']} total, "
          f"{c['unhealthy']} nesănătoase, {c['exited']} oprite neașteptat")
        if c["residual"]:
            A(f"  Reziduuri      : {len(c['residual'])} snapshot-uri "
              "pre-upgrade (oprite intenționat)")
        for p in c["problems"][:6]:
            A(f"    ! {p}")
    else:
        A("  NEVERIFICABIL — docker ps a eșuat")
    if r:
        A(f"  RAM            : {r.get('ram_used','?')}/"
          f"{r.get('ram_total','?')} GB")
        A(f"  Disc           : {r.get('disk_used','?')}/"
          f"{r.get('disk_total','?')} ({r.get('disk_pct','?')})")
        A(f"  Uptime         : {r.get('uptime','?')}")
    A("")

    A("SERVICII CRITICE (verificat individual)")
    for k, v in critical_services().items():
        mark = "ok" if "running" in v and "unhealthy" not in v else "!!"
        A(f"  [{mark}] {k:22} {v}")
    A("")

    A("MEMORIE RONOR")
    st = rmemory_stats()
    if "eroare" in st:
        A(f"  NEVERIFICABIL — {st['eroare']}")
    else:
        A(f"  Colecție       : {st.get('collection','?')}")
        A(f"  Memorii        : {st.get('points_count','?')}")
        A(f"  Stare Qdrant   : {st.get('status','?')}")
        if st.get("indexed_vectors_count") == 0:
            A("  ! index vectorial nul — de investigat")
    A("")

    A("GUVERNANȚĂ OPERATORI")
    op = operators_state()
    if "operatori" in op:
        A(f"  Operatori      : {op['operatori']} înregistrați")
        A(f"  Acțiuni        : {op.get('actiuni','?')} guvernate")
    else:
        A(f"  {op.get('stare','?')} {op.get('detaliu','')[:60]}")
    A("")

    A("POȘTĂ / DMARC (resolver public independent)")
    for d, p in dmarc_policy().items():
        A(f"  {d:16} {p}")
    A("")

    if kind == "OBD":
        A("PRIORITĂȚI PROPUSE ASTĂZI")
        A("  1. Corpusuri de domeniu — operatorii sunt inerți fără ele (A3)")
        A("  2. Primul Exit Drill — scor 0, niciodată executat")
        A("  3. Persistență Claims Register (D-15) — 5 revendicări volatile")
        A("")
        A("BLOCAJE PE DECIZIA PRINCIPALULUI")
        A("  - Resend Pro 20 USD/lună -> expediere de pe ronor.tech")
        A("  - Achiziție 7 domenii ~221 USD (nrgpaths.ai deblochează site-ul)")
        A("  - Contor de priză pentru EII-1 audited (~30-120 RON)")
        A("  - Factură NrgPaths pentru EII-2 (EUR total / kWh total)")
        A("  - Evaluare consilier IP: conflict yco-tec clasele 9+42")
    elif kind == "CBD":
        A("BILANȚ ZIUA ÎNCHEIATĂ")
        A("  Acest raport acoperă starea măsurabilă a sistemului.")
        A("  Execuțiile zilei se consemnează în registrul de taskuri.")
    else:
        A("TO-DO GENERAL — registrul canonic:")
        A("  /opt/ronor/reports/TODO_GENERAL.md")
    A("")
    A("-" * 36)
    A("Generat pe nodul suveran. Fără infrastructură Manus.")
    A("Doar stare verificată. Limitările sunt declarate explicit.")
    return "\n".join(L)


def main():
    kind = (sys.argv[1] if len(sys.argv) > 1 else "OBD").upper()
    if kind not in ("OBD", "CBD", "TODO"):
        print("uz: ronor_report.py OBD|CBD|TODO")
        return 2
    txt = build(kind)
    os.makedirs(ARCHIVE, exist_ok=True)
    stamp = datetime.now(TZ).strftime("%Y%m%d_%H%M")
    path = os.path.join(ARCHIVE, f"{kind}_{stamp}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(txt)
    print(txt)

    ok_t, msg_t = send_telegram(txt)
    subj = f"RONOR {kind} — {datetime.now(TZ).strftime('%d.%m.%Y %H:%M')}"
    ok_e, msg_e = send_email(subj, txt)
    print(f"\n[Telegram] {'OK' if ok_t else 'EȘEC'}: {msg_t}")
    print(f"[E-mail]   {'OK' if ok_e else 'EȘEC'}: {msg_e}")
    print(f"[Arhivă]   {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
