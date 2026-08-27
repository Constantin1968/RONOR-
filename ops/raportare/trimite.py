#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Driver de livrare pentru raportarea RONOR (cens + randare).

Colecteaza, randeaza si livreaza pe aceleasi canale ca scriptul anterior:
Telegram si e-mail prin Resend. Refoloseste functiile de trimitere din
/opt/ronor/ronor_report.py ca sa nu existe doua implementari ale livrarii.

Bucla e: colector.py scrie censul -> randare.py produce textul ->
trimite.py il livreaza. Fiecare pas se poate rula si separat.
"""
import os
import subprocess
import sys
import time

AICI = os.path.dirname(os.path.abspath(__file__))
VECHI = "/opt/ronor"
sys.path.insert(0, VECHI)

TIPURI = {"OBD": "DESCHIDEREA ZILEI", "CBD": "ÎNCHIDEREA ZILEI",
          "TODO": "SARCINI SĂPTĂMÂNALE"}


def ruleaza(argv, timeout=240):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


def main():
    tip = (sys.argv[1] if len(sys.argv) > 1 else "CBD").upper()
    if tip not in TIPURI:
        print("tip necunoscut: %s (aștept OBD, CBD sau TODO)" % tip)
        return 2
    sec = "--sec" in sys.argv

    cens = "/opt/ronor/reports/cens-%s.json" % time.strftime("%Y%m%d-%H%M")
    cod, ies, err = ruleaza([sys.executable, os.path.join(AICI, "colector.py"),
                             "-o", cens] + (["--sec"] if sec else []))
    if cod != 0:
        print("colectorul a eșuat (cod %s): %s" % (cod, (err or ies)[:400]))
        return 1
    print(ies.strip())

    cod, text, err = ruleaza([sys.executable, os.path.join(AICI, "randare.py"),
                              "-c", cens, "-t", tip], timeout=90)
    if cod != 0:
        print("randarea a eșuat (cod %s): %s" % (cod, (err or text)[:400]))
        return 1

    if sec:
        print(text)
        print("\n[regim sec] nu s-a trimis nimic")
        return 0

    try:
        from ronor_report import send_telegram, send_email
    except Exception as e:
        print("nu pot importa livrarea din ronor_report.py: %s" % e)
        return 1

    ok_tg, det_tg = send_telegram(text)
    subiect = "RONOR — %s — %s" % (TIPURI[tip], time.strftime("%d.%m.%Y"))
    ok_em, det_em = send_email(subiect, text)
    print("telegram: %s (%s) | email: %s (%s)"
          % ("trimis" if ok_tg else "eșuat", det_tg,
             "trimis" if ok_em else "eșuat", det_em))
    return 0 if (ok_tg or ok_em) else 1


if __name__ == "__main__":
    sys.exit(main())
