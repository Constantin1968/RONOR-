#!/usr/bin/env python3
"""Schemă grafică RONOR — stare actuală, stare țintă, drumul pe porți."""
from reportlab.pdfgen import canvas as canvas_mod
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

F = "/usr/share/fonts/truetype/crosextra/"
D = "/usr/share/fonts/truetype/dejavu/"
pdfmetrics.registerFont(TTFont("S", F + "Carlito-Regular.ttf"))
pdfmetrics.registerFont(TTFont("SB", F + "Carlito-Bold.ttf"))
pdfmetrics.registerFont(TTFont("M", D + "DejaVuSansMono.ttf"))
pdfmetrics.registerFont(TTFont("MB", D + "DejaVuSansMono-Bold.ttf"))

INK   = HexColor("#28251D")
MUT   = HexColor("#6B6A65")
FNT   = HexColor("#9A9994")
RULE  = HexColor("#D4D1CA")
TEAL  = HexColor("#01696F")
TEALD = HexColor("#0C4E54")
TEALL = HexColor("#E4EFEF")
CRIT  = HexColor("#A12C7B")
CRITL = HexColor("#F7E7F1")
WARN  = HexColor("#964219")
GOOD  = HexColor("#437A22")
GOODL = HexColor("#EBF3E4")
SURF  = HexColor("#F4F3EF")
SURF2 = HexColor("#FAFAF8")
WHITE = HexColor("#FFFFFF")

W, H = 420 * mm, 297 * mm


class D3:
    def __init__(self, path):
        self.c = canvas_mod.Canvas(path, pagesize=(W, H))

    def txt(self, x, y, s, size=8, font="S", col=INK, align="l"):
        c = self.c
        c.setFont(font, size)
        c.setFillColor(col)
        if align == "l":
            c.drawString(x * mm, y * mm, s)
        elif align == "c":
            c.drawCentredString(x * mm, y * mm, s)
        else:
            c.drawRightString(x * mm, y * mm, s)

    def box(self, x, y, w, h, fill=WHITE, border=RULE, lw=0.6, r=1.4):
        c = self.c
        c.setLineWidth(lw)
        c.setStrokeColor(border)
        c.setFillColor(fill)
        c.roundRect(x * mm, y * mm, w * mm, h * mm, r * mm, stroke=1, fill=1)

    def band(self, x, y, w, h, col):
        c = self.c
        c.setFillColor(col)
        c.setStrokeColor(col)
        c.rect(x * mm, y * mm, w * mm, h * mm, stroke=0, fill=1)

    def line(self, x1, y1, x2, y2, col=RULE, lw=0.7, dash=None):
        c = self.c
        c.setLineWidth(lw)
        c.setStrokeColor(col)
        if dash:
            c.setDash(dash, 2)
        c.line(x1 * mm, y1 * mm, x2 * mm, y2 * mm)
        c.setDash([], 0)

    def arrow(self, x1, y1, x2, y2, col=TEAL, lw=1.0, dash=None, head=2.0):
        import math
        self.line(x1, y1, x2, y2, col, lw, dash)
        ang = math.atan2(y2 - y1, x2 - x1)
        c = self.c
        c.setFillColor(col)
        c.setStrokeColor(col)
        p = c.beginPath()
        p.moveTo(x2 * mm, y2 * mm)
        p.lineTo((x2 - head * math.cos(ang - 0.42)) * mm,
                 (y2 - head * math.sin(ang - 0.42)) * mm)
        p.lineTo((x2 - head * math.cos(ang + 0.42)) * mm,
                 (y2 - head * math.sin(ang + 0.42)) * mm)
        p.close()
        c.drawPath(p, stroke=0, fill=1)

    def blocked(self, x, y, size=3.4, col=CRIT):
        s = size / 2.0
        self.line(x - s, y - s, x + s, y + s, col, 1.7)
        self.line(x - s, y + s, x + s, y - s, col, 1.7)

    def card(self, x, y, w, h, title, lines, accent=TEAL, fill=WHITE,
             tsize=7.8, lsize=6.6, badge=None, badgecol=None, lead=3.3):
        self.box(x, y, w, h, fill=fill, border=accent, lw=0.9)
        self.band(x, y + h - 0.9, w, 0.9, accent)
        ty = y + h - 5.2
        self.txt(x + 2.6, ty, title, tsize, "SB", INK)
        if badge:
            self.txt(x + w - 2.6, ty, badge, 6.2, "SB", badgecol or accent, align="r")
        yy = ty - 3.9
        for ln, col, fnt in lines:
            self.txt(x + 2.6, yy, ln, lsize, fnt, col)
            yy -= lead

    def header(self, title, sub, tag):
        self.band(0, H / mm - 5, W / mm, 5, TEALD)
        self.txt(14, H / mm - 20, title, 20, "SB", INK)
        self.line(14, H / mm - 24, 130, H / mm - 24, TEAL, 1.8)
        self.txt(14, H / mm - 31, sub, 10, "S", MUT)
        self.txt(W / mm - 14, H / mm - 20, tag, 9, "SB", TEAL, align="r")

    def footer(self, left, right):
        self.line(14, 10, W / mm - 14, 10, RULE, 0.5)
        self.txt(14, 6, left, 6.8, "S", FNT)
        self.txt(W / mm - 14, 6, right, 6.8, "S", FNT, align="r")

    def legend(self, x, y, items, gap=52):
        for i, (col, lab) in enumerate(items):
            xx = x + i * gap
            self.box(xx, y, 4.5, 3.2, fill=col, border=col, lw=0.5, r=0.5)
            self.txt(xx + 6.5, y + 0.5, lab, 6.6, "S", MUT)

    def page(self):
        self.c.showPage()

    def save(self):
        self.c.save()


d = D3("/home/user/workspace/RONOR-schema.pdf")

# =====================================================================
# PAGINA 1 — UNDE SUNT ACUM
# =====================================================================
d.header("Unde sunt acum",
         "RONOR — topologia reală, măsurată pe 25 august 2026, după aplicarea P0-1",
         "PAGINA 1 / 3")

d.txt(14, 246, "INTERNET PUBLIC", 8.4, "SB", CRIT)
d.line(14, 244, 74, 244, CRIT, 1.2)
d.card(14, 212, 60, 26, "Oricine, de oriunde", [
    ("fără credențială", MUT, "S"),
    ("fără cont", MUT, "S"),
    ("scanere automate incluse", MUT, "S"),
], accent=CRIT, fill=CRITL)
d.txt(14, 206, "HTTP :80  →  178.104.118.10", 6.6, "M", CRIT)

d.txt(346, 246, "TAILNET PRIVAT", 8.4, "SB", GOOD)
d.line(346, 244, 406, 244, GOOD, 1.2)
d.card(346, 206, 60, 32, "Arhitect", [
    ("laptop DESKTOP-EAPCQUG", MUT, "S"),
    ("client de control, Windows", MUT, "S"),
    ("tailnet 100.64.0.0/10", MUT, "M"),
    ("7 noduri, plan Free", MUT, "S"),
], accent=GOOD, fill=GOODL)
d.txt(406, 201, "acces complet  ·  toate căile 200", 6.6, "SB", GOOD, align="r")

d.box(84, 56, 252, 188, fill=SURF2, border=TEALD, lw=1.4, r=2)
d.band(84, 236, 252, 8, TEALD)
d.txt(88, 238.6, "GAZDA HETZNER  ·  ronor-secondary  ·  16 vCPU, 30 G, 58 containere  ·  gazda de facto",
      8.6, "SB", WHITE)
d.txt(332, 238.6, "178.104.118.10   100.83.241.57", 7.4, "M", TEALL, align="r")

d.box(90, 174, 240, 54, fill=WHITE, border=TEAL, lw=1.2, r=1.6)
d.band(90, 220.5, 240, 7.5, TEAL)
d.txt(93.5, 222.8, "CADDY v2.11.4  —  singura margine  ·  admin off  ·  order respond first",
      8.2, "SB", WHITE)
d.txt(326.5, 222.8, "175 → 192 linii", 7, "M", TEALL, align="r")

d.box(94, 179, 112, 38, fill=GOODL, border=GOOD, lw=0.8)
d.txt(97, 212.5, "RĂMÂNE PUBLIC — intenționat", 7.4, "SB", GOOD)
pub = [("cidavault.com", "200", "prin Cloudflare"),
       ("control.ronor.tech", "401", "TLS ACME + basic_auth"),
       ("/cida/", "200", "cheie la nivel de aplicație"),
       ("/", "200", "→ Langfuse  ·  decizia P0-2")]
yy = 208
for path, code, note in pub:
    d.txt(97, yy, path, 6.6, "M", INK)
    d.txt(151, yy, code, 6.6, "MB", GOOD)
    d.txt(161, yy, note, 6.4, "S", MUT)
    yy -= 4.4

d.box(212, 179, 114, 38, fill=TEALL, border=TEAL, lw=0.8)
d.txt(215, 212.5, "ÎNCHIS AZI — 403 pentru orice sursă din afară", 7.4, "SB", TEALD)
d.txt(215, 208.2, "/gw/*   /temporal*   /langgraph/*   /crewai*", 6.5, "M", TEALD)
d.txt(215, 204.2, "/r-monitor/*   /r-execute/*   /r-schedule/*", 6.5, "M", TEALD)
d.txt(215, 200.2, "/guardrails/*   /nemo/*   /lakera/*", 6.5, "M", TEALD)
d.txt(215, 196.2, "/comms*   /memory*   /dashboard*   /qdrant/*", 6.5, "M", TEALD)
d.txt(215, 190.6, "14 căi  ·  permis doar din 100.64.0.0/10, 172.20.0.0/16, 127.0.0.1/8",
      6.4, "SB", TEALD)
d.txt(215, 186.2, "verificat prin sondare publică: toate 403", 6.4, "S", TEAL)
d.txt(215, 182.0, "verificat din interior prin 127.0.0.1: toate 200", 6.4, "S", TEAL)

d.arrow(74, 219, 88, 212, CRIT, 1.2)
d.arrow(346, 214, 332, 208, GOOD, 1.2)
d.blocked(269, 172.5)
d.txt(274, 171.2, "403 Forbidden", 7, "SB", CRIT)
d.arrow(120, 179, 120, 170, GOOD, 1.0)

d.txt(90, 168, "SERVICIILE DIN SPATELE MARGINII  —  toate răspund normal pe 127.0.0.1; niciunul nu a fost atins",
      7.6, "SB", INK)

svc = [
    ("Portkey AI Gateway", ":8787", [("poarta de modele", MUT),
                                     ("fără autentificare proprie", CRIT),
                                     ("era E-01: banii se scurgeau", CRIT)], TEAL, "ÎNCHIS"),
    ("Temporal", "UI + API", [("orchestrarea fluxurilor", MUT),
                              ("namespace ronor", MUT),
                              ("era E-02", WARN)], TEAL, "ÎNCHIS"),
    ("LangGraph", "assistants", [("ronor_reasoner", MUT),
                                 ("accepta POST fără cheie", CRIT),
                                 ("era E-03", WARN)], TEAL, "ÎNCHIS"),
    ("Guardrails · NeMo · Lakera", "strat de siguranță",
     [("apărarea anti-injecție", MUT), ("era ea însăși expusă", CRIT),
      ("era E-04", WARN)], TEAL, "ÎNCHIS"),
    ("r-comms", ":8100", [("SMTP + IMAP configurate", MUT),
                          ("token Telegram partajat", CRIT),
                          ("POST /telegram/send neguvernat", CRIT)], WARN, "ÎNCHIS"),
    ("r-memory + Qdrant", "colecția ronor", [("memoria vectorială", MUT),
                                             ("qdrant_ok: true", GOOD),
                                             ("cheie la nivel de aplicație", GOOD)], TEAL, "ÎNCHIS"),
    ("Command Center", "/opt/ronor-cc", [("tabloul de bord React", MUT),
                                         ("fără .git, fără supervizor", CRIT),
                                         ("proces orfan, 11+ zile", CRIT)], WARN, "ÎNCHIS"),
    ("Langfuse", ":3000", [("observabilitate", MUT),
                           ("prinde rădăcina publică /", WARN),
                           ("decizia P0-2", WARN)], WARN, "PUBLIC"),
    ("MinIO", ":9091", [("stocare de obiecte", MUT),
                        ("basic_auth în Caddy", GOOD),
                        ("corect de la început", GOOD)], GOOD, "401"),
    ("CIDAVault", ":3100", [("cidavault.com", MUT),
                            ("public intenționat", GOOD),
                            ("prin Cloudflare", GOOD)], GOOD, "200"),
    ("Planurile Gen 1.5", "r-monitor/execute/schedule",
     [("Python, în viață 11+ zile", MUT), ("în niciun repozitoriu", CRIT),
      ("țin lumina aprinsă", WARN)], WARN, "ÎNCHIS"),
    ("Telemetrie · pool", ":8401 · :8402", [("servesc /control", MUT),
                                            ("basic_auth în Caddy", GOOD),
                                            ("în niciun repozitoriu", CRIT)], WARN, "401"),
]
x0, y0, cw, ch, gx, gy = 90, 62, 58.5, 31, 2, 2.5
for i, (name, sub, lines, accent, badge) in enumerate(svc):
    cx = x0 + (i % 4) * (cw + gx)
    cy = y0 + (2 - i // 4) * (ch + gy)
    bc = TEAL if badge == "ÎNCHIS" else (WARN if badge == "PUBLIC" else GOOD)
    d.card(cx, cy, cw, ch, name, [(sub, TEALD, "M")] + [(t, c, "S") for t, c in lines],
           accent=accent, fill=WHITE, tsize=7.2, lsize=6.1, badge=badge, badgecol=bc)

d.txt(14, 48, "CELELALTE TREI GAZDE ȘI BOTUL  —  neatinse de intervenția de astăzi", 8.4, "SB", INK)
d.line(14, 46, 406, 46, RULE, 0.6)

others = [
    ("GAZDA DIGITALOCEAN  ·  ronor-sovereign", "165.245.248.223  ·  100.124.123.90",
     [("14 containere, dar planesHealthy 0/8", CRIT),
      ("do-frankfurt: down  ·  ramură veche, ~25 commituri în urmă", WARN),
      ("Postgres 16 deschis public pe :5432  —  C-02, nerezolvat", CRIT),
      ("nu răspunde HTTP public: inutilă pentru dvs., utilă altcuiva", CRIT)], CRIT),
    ("GAZDA CONTABO", "169.58.129.223  ·  100.87.14.42",
     [("SSH refuză cheia: Permission denied (publickey,password)", CRIT),
      ("propriul tablou de bord o raportează provisioning", WARN),
      ("Whisper deschis, neautentificat, pe :8200  —  C-01, nerezolvat", CRIT),
      ("suspectul principal pentru conflictele getUpdates", WARN)], CRIT),
    ("BASTION DIGITALOCEAN", "100.77.197.28",
     [("gol", MUT), ("niciun rol declarat", MUT),
      ("în tailnet, fără sarcină", MUT), ("de retras sau de folosit", MUT)], MUT),
    ("RONOR BOT  ·  @ronor_sovereign_bot", "id 8885653110",
     [("MORT pe ambele gazde din 10 august", CRIT),
      ("RestartPolicy: no  —  SIGTERM, exit 0, 15 zile neobservat", CRIT),
      ("0 comenzi înregistrate la Telegram, niciun webhook", CRIT),
      ("un al treilea consumator necunoscut a interogat pe 9-10 august", WARN)], CRIT),
]
ow = (392 - 3 * 3) / 4.0
for i, (name, sub, lines, accent) in enumerate(others):
    ox = 14 + i * (ow + 3)
    d.card(ox, 14, ow, 29, name, [(sub, TEALD, "M")] + [(t, c, "S") for t, c in lines],
           accent=accent, fill=SURF2, tsize=7.0, lsize=6.0)

d.footer("NrgPaths Advisory Ltd  —  schemă construită din măsurători directe: Caddyfile citit integral, 18 căi sondate public și din interior, docker inspect, tailscale status",
         "Intern  ·  25 august 2026")
d.page()

# =====================================================================
# PAGINA 2 — UNDE TREBUIE SĂ AJUNGEM
# =====================================================================
d.header("Unde trebuie să ajungem",
         "Starea țintă: o singură suprafață de comandă, un singur canal mobil, o singură bază de cunoaștere",
         "PAGINA 2 / 3")

d.txt(14, 246, "PUBLIC", 8.4, "SB", GOOD)
d.line(14, 244, 74, 244, GOOD, 1.2)
d.card(14, 202, 60, 38, "Vizitator public", [
    ("vede site-ul RONOR", MUT, "S"),
    ("vede cidavault.com", MUT, "S"),
    ("nu vede nicio unealtă", GOOD, "SB"),
    ("nu vede nicio stare internă", GOOD, "SB"),
    ("403 pe orice cale operațională", GOOD, "S"),
], accent=GOOD, fill=GOODL)

d.txt(346, 246, "ARHITECT", 8.4, "SB", TEAL)
d.line(346, 244, 406, 244, TEAL, 1.2)
d.card(346, 188, 60, 52, "Două intrări, o singură comandă", [
    ("ronor.tech — site public", MUT, "M"),
    ("control.ronor.tech —", MUT, "M"),
    ("   suprafața de comandă, TLS,", MUT, "S"),
    ("   autentificată, cu revizie", MUT, "S"),
    ("", MUT, "S"),
    ("Telegram — canal mobil:", TEAL, "SB"),
    ("   aprobări, co-semnare, teren", MUT, "S"),
    ("", MUT, "S"),
    ("tailnet — administrare", MUT, "S"),
], accent=TEAL, fill=TEALL)

d.box(84, 118, 252, 126, fill=SURF2, border=TEALD, lw=1.4, r=2)
d.band(84, 236, 252, 8, TEALD)
d.txt(88, 238.6, "NUCLEU GUVERNAT  —  o gazdă cu rol declarat, revizie cunoscută, supervizor pe fiecare proces",
      8.6, "SB", WHITE)

d.box(90, 212, 240, 20, fill=WHITE, border=TEAL, lw=1.1)
d.txt(93, 225.5, "MARGINE UNICĂ — Caddy", 7.8, "SB", TEALD)
d.txt(93, 221, "public: doar site-ul și cidavault  ·  operațional: doar tailnet  ·  comandă: TLS + autentificare",
      6.6, "S", MUT)
d.txt(93, 216.6, "admin off  ·  ordinea directivelor fixată explicit  ·  fiecare cale are un proprietar declarat",
      6.6, "S", MUT)
d.arrow(74, 222, 88, 222, GOOD, 1.2)
d.arrow(346, 222, 332, 222, TEAL, 1.2)

tgt = [
    ("O SINGURĂ SUPRAFAȚĂ DE COMANDĂ", [
        ("decizia P2-1: consola din repozitoriu", INK, "SB"),
        ("sau tabloul de bord React — nu ambele", MUT, "S"),
        ("versionată în main, cu supervizor", MUT, "S"),
        ("revizia afișată în interfață", MUT, "S"),
        ("cheia de arhitect nu trece prin browser", MUT, "S"),
    ], TEAL),
    ("RONOR BOT, VIU ȘI GUVERNAT", [
        ("8 comenzi înregistrate la Telegram", MUT, "S"),
        ("streaming nativ prin sendMessageDraft", MUT, "S"),
        ("co-semnare între doi semnatari distincți", CRIT, "SB"),
        ("token propriu, separat de r-comms", MUT, "S"),
        ("restart: unless-stopped + healthcheck", MUT, "S"),
    ], TEAL),
    ("RUNTIME GEN 2 ÎN PRODUCȚIE", [
        ("13.114 linii, 1.084 teste trecute", GOOD, "SB"),
        ("verified_confidence populat — C-09 închis", MUT, "S"),
        ("mandat semnat pe server", MUT, "S"),
        ("evidence runner izolat", MUT, "S"),
        ("Gen 1.5 oprit deliberat, nu din inerție", MUT, "S"),
    ], TEAL),
    ("O SINGURĂ BAZĂ DE CUNOAȘTERE", [
        ("Qdrant + schema cida, unificate", MUT, "S"),
        ("partajată: comanda și canalul mobil", MUT, "S"),
        ("contextul nu se reconstruiește manual", MUT, "S"),
        ("proiectele au fișiere și cunoaștere activă", MUT, "S"),
        ("docs/ descrie sistemul care rulează", MUT, "S"),
    ], TEAL),
    ("PATRIMONIU CURAT", [
        ("fiecare gazdă: rol și revizie declarate", MUT, "S"),
        ("Contabo: recuperată sau retrasă", WARN, "SB"),
        ("DigitalOcean: refăcută sau retrasă", WARN, "SB"),
        ("niciun port public nedorit", MUT, "S"),
        ("C-01, C-02, C-03 închise", MUT, "S"),
    ], TEAL),
    ("GUVERNANȚĂ CU ÎNȚELES", [
        ("aceleași ponderi pe toate gazdele", MUT, "S"),
        ("SOVEREIGNTY și EVIDENCE peste tot", MUT, "S"),
        ("atribuirea AI prezentă — C-11 închis", MUT, "S"),
        ("CIDA: verdictul se poate reemite", MUT, "S"),
        ("audit per acțiune — deja peste Grok", GOOD, "SB"),
    ], GOOD),
]
tw = (240 - 2 * 4) / 3.0
for i, (name, lines, accent) in enumerate(tgt):
    tx = 90 + (i % 3) * (tw + 4)
    ty = 168 - (i // 3) * 42
    d.card(tx, ty, tw, 38, name, lines, accent=accent, fill=WHITE,
           tsize=7.4, lsize=6.3, lead=3.5)

d.box(14, 34, 392, 62, fill=SURF, border=TEALD, lw=1.0)
d.band(14, 88, 392, 8, TEALD)
d.txt(18, 90.6, "CE ÎNSEAMNĂ „RONOR FINALIZAT\"  —  criterii verificabile prin apel, nu prin declarație",
      8.6, "SB", WHITE)
crit_rows = [
    ("Rădăcina publică", "servește ce a fost decis; nicio cale operațională nu răspunde 200 neautentificat"),
    ("Suprafața de comandă", "una singură, versionată, cu supervizor, autentificată, cu revizia afișată"),
    ("Interfața de arhitect", "servită din repozitoriu; cheia nu trece prin stocarea browserului; rutele din docs = rutele din cod"),
    ("RONOR Bot", "răspunde la 8 comenzi, streaming nativ, co-semnare între doi identificatori, supervizor, declarat în compose"),
    ("„RONOR App\"", "declarat în docs/interface-plan.md — implementat sau eliminat din vocabular; niciun termen fără referent"),
    ("Runtime", "Gen 2 servește trafic real, verified_confidence populat, Gen 1.5 oprit sau păstrat deliberat"),
    ("Gazdele", "fiecare cu rol declarat și revizie cunoscută; niciun port public nedorit; Contabo controlată sau retrasă"),
    ("Cunoaștere și documentație", "o singură bază canonică; docs/ descrie sistemul care rulează; niciun document nu contrazice codul"),
]
yy = 80
for i, (k, v) in enumerate(crit_rows):
    col = 18 if i < 4 else 212
    if i == 4:
        yy = 80
    d.txt(col, yy, k, 6.9, "SB", TEALD)
    d.txt(col, yy - 3.6, v, 6.3, "S", MUT)
    yy -= 10.4

d.footer("NrgPaths Advisory Ltd  —  starea țintă derivă din doctrina din 6 august, acum implementabilă: ronor.tech vă aparține și control.ronor.tech funcționează deja cu TLS propriu",
         "Intern  ·  25 august 2026")
d.page()

# =====================================================================
# PAGINA 3 — DRUMUL
# =====================================================================
d.header("Drumul, pe porți de dependență",
         "Fiecare poartă se deschide doar când cea de dinainte e închisă — ordonare prin dependență, nu prin timp",
         "PAGINA 3 / 3")

d.box(14, 244, 392, 20, fill=GOODL, border=GOOD, lw=1.0)
d.txt(18, 257.5, "CE S-A FĂCUT ASTĂZI", 8.4, "SB", GOOD)
d.txt(18, 252.6, "P0-1 aplicat și verificat empiric: 14 căi operaționale au trecut de la 200 neautentificat la 403 pentru orice sursă din afara tailnet-ului.",
      6.9, "S", INK)
d.txt(18, 248.2, "Zero servicii atinse. Zero erori în jurnal. Accesul din interior și din tailnet, intact. Două copii de siguranță. Revenirea: o comandă.",
      6.9, "S", INK)
d.txt(402, 257.5, "K-05 închis  ·  E-01 … E-06 închise", 7.4, "SB", GOOD, align="r")
d.txt(402, 252.6, "cea mai costisitoare expunere — poarta de modele — nu mai răspunde public",
      6.6, "S", MUT, align="r")

gates = [
    ("POARTA ZERO", "Oprirea expunerii", GOOD, "ÎN CURS", [
        ("P0-1  închiderea celor 14 căi la margine", "FĂCUT ASTĂZI", GOOD),
        ("P0-2  decizia despre rădăcina publică", "urmează", WARN),
        ("P0-3  rotația cheilor de API RONOR", "cere acord", CRIT),
        ("P0-4  codurile de recuperare GitHub, de pe laptop", "la cerere", WARN),
        ("P0-5  C-01 Whisper, C-02 Postgres, C-03 ufw", "pe alte gazde", CRIT),
    ], "se închide când nicio gazdă nu mai returnează 200 neautentificat pe o cale operațională și cheile sunt rotite"),
    ("POARTA UNU", "Recâștigarea cunoașterii", TEAL, "URMEAZĂ", [
        ("P1-1  /opt/ronor-cc sub control de versiune", "nivel B", TEAL),
        ("P1-2  planurile Python Gen 1.5, versionate", "nivel B", TEAL),
        ("P1-3  configurațiile reale ale containerelor", "nivel B", TEAL),
        ("P1-4  Contabo: acces sau declararea pierderii", "decizie", WARN),
        ("P1-5  reconcilierea celor trei stări ale codului", "execut oricând", GOOD),
    ], "se închide când fiecare proces din producție are sursă versionată, supervizor și revizie cunoscută"),
    ("POARTA DOI", "Decizia de interfețe", WARN, "BLOCATĂ PE DVS.", [
        ("P2-1  care e suprafața principală — una, nu două", "DECIZIE", CRIT),
        ("P2-2  /control servește interfața din repozitoriu", "nivel B", TEAL),
        ("P2-3  cheia de arhitect iese din sessionStorage", "cere acord", CRIT),
        ("P2-4  „RONOR App\" se declară sau se elimină", "DECIZIE", CRIT),
        ("P2-5  planul se scrie în repozitoriu", "cere push", CRIT),
    ], "se închide când există în main un document care răspunde la cele patru întrebări și Caddy îl reflectă"),
    ("POARTA TREI", "Botul, însănătoșit", TEAL, "ORDINE STRICTĂ", [
        ("P3-1  localizarea celei de-a treia instanțe", "execut", GOOD),
        ("P3-2  separarea tokenului față de r-comms", "cere acord", CRIT),
        ("P3-3  contradicția polling / webhook", "nivel B", TEAL),
        ("P3-4  declarare în compose + restart real", "nivel B", TEAL),
        ("P3-5 … P3-7  comenzi, co-semnare, ponderi", "mixt", TEAL),
    ], "o repornire înaintea P3-1 și P3-2 produce al doilea conflict getUpdates și pierdeți din nou vizibilitatea"),
    ("POARTA PATRU", "Paritatea cu Grok", TEAL, "DUPĂ POARTA TREI", [
        ("1  sendMessageDraft — cea mai mare diferență", "efort mic", GOOD),
        ("2  indicator nativ de gândire", "efort nul", GOOD),
        ("3  can_stop + oprirea generării", "efort mic", GOOD),
        ("4  butoane danger/success, DisabledButton la TTL", "efort mic", GOOD),
        ("5 … 8  memorie, unelte, Rich Messages, voce", "mediu → mare", WARN),
    ], "se închide când un utilizator care nu știe ce rulează dedesubt nu poate distinge botul de un asistent comercial"),
    ("POARTA CINCI", "Desfășurarea Gen 2", CRIT, "CERE ACORD", [
        ("P5-1  închiderea C-09 verified_confidence", "cere acord", CRIT),
        ("P5-2  integrarea celor 16 ramuri locale", "merge uman", CRIT),
        ("P5-3  desfășurarea pe Hetzner, în paralel", "cere acord", CRIT),
        ("P5-4  DigitalOcean: reînviere sau retragere", "decizie", WARN),
    ], "se închide când Gen 2 servește trafic real cu revizie cunoscută, iar Gen 1.5 e oprit sau păstrat deliberat"),
    ("POARTA ȘASE", "CIDA și cunoașterea", TEAL, "LA FINAL", [
        ("P6-1  neconformitățile critice K-01 … K-05", "K-05 închis astăzi", GOOD),
        ("P6-2  o singură bază de cunoaștere", "nivel B", TEAL),
        ("P6-3  proiectele: fișiere și cunoaștere activă", "execut la cerere", GOOD),
        ("P6-4  atribuirea AI — C-11", "nivel B", TEAL),
        ("P6-5  43 din 47 de fișiere .md sunt învechite", "nivel B", TEAL),
    ], "se închide când neconformitățile critice și grave sunt rezolvate și verdictul CIDA se poate reemite"),
]

gw_ = (392 - 6 * 2.5) / 7.0
GY, GH = 116, 124
for i, (num, name, accent, status, items, close) in enumerate(gates):
    gx_ = 14 + i * (gw_ + 2.5)
    d.box(gx_, GY, gw_, GH, fill=WHITE, border=accent, lw=1.0)
    d.band(gx_, GY + GH - 14, gw_, 14, accent)
    d.txt(gx_ + 2.4, GY + GH - 6.2, num, 8.2, "SB", WHITE)
    d.txt(gx_ + 2.4, GY + GH - 11.4, name, 7.0, "S", WHITE)
    d.txt(gx_ + 2.4, GY + GH - 19.6, status, 6.4, "SB", accent)
    yy = GY + GH - 26
    for lab, tag, tcol in items:
        words = lab.split()
        l1, l2 = "", ""
        for w_ in words:
            if len(l1) + len(w_) + 1 <= 31 and not l2:
                l1 = (l1 + " " + w_).strip()
            else:
                l2 = (l2 + " " + w_).strip()
        d.txt(gx_ + 2.4, yy, l1, 6.2, "S", INK)
        if l2:
            yy -= 3.2
            d.txt(gx_ + 2.4, yy, l2, 6.2, "S", INK)
        yy -= 3.4
        d.txt(gx_ + 2.4, yy, tag, 5.8, "SB", tcol)
        yy -= 6.4
    d.line(gx_ + 2.4, GY + 24, gx_ + gw_ - 2.4, GY + 24, RULE, 0.5)
    words = close.split()
    lines_, cur = [], ""
    for w_ in words:
        if len(cur) + len(w_) + 1 <= 35:
            cur = (cur + " " + w_).strip()
        else:
            lines_.append(cur)
            cur = w_
    lines_.append(cur)
    yy = GY + 20
    for ln in lines_[:6]:
        d.txt(gx_ + 2.4, yy, ln, 5.7, "S", MUT)
        yy -= 3.1
    if i < 6:
        d.arrow(gx_ + gw_ + 0.2, GY + GH - 7, gx_ + gw_ + 2.3, GY + GH - 7,
                accent, 1.0, head=1.6)

d.box(14, 76, 392, 32, fill=CRITL, border=CRIT, lw=1.0)
d.band(14, 100, 392, 8, CRIT)
d.txt(18, 102.6, "CE NU POT EXECUTA EU  —  patru decizii și un tip de acces care vă aparțin",
      8.6, "SB", WHITE)
dec = [
    "P2-1  care suprafață devine cea principală — consola din repozitoriu sau tabloul de bord React",
    "P2-4  „RONOR App\" se implementează ca Mini App Telegram, ca aplicație web progresivă, sau se elimină din vocabular",
    "P3-6  cine e al doilea semnatar — fără el, co-semnarea e teatru de guvernanță",
    "P5-4  DigitalOcean și Contabo: refăcute sau retrase din inventar",
    "consolele de furnizor — Hetzner, Contabo, DigitalOcean, GitHub — nu se accesează de pe IP rusesc",
]
yy = 94
for i, t in enumerate(dec):
    col = 18 if i < 3 else 212
    if i == 3:
        yy = 94
    d.txt(col, yy, "•  " + t, 6.6, "S", INK)
    yy -= 5.2

d.box(14, 16, 392, 44, fill=SURF, border=TEALD, lw=1.0)
d.band(14, 52, 392, 8, TEALD)
d.txt(18, 54.6, "PRIMA ACȚIUNE PROPUSĂ  —  P0-2, decizia despre rădăcina publică", 8.6, "SB", WHITE)
d.txt(18, 45.6, "Astăzi „/\" trimite la Langfuse, deci prima impresie a RONOR pe internet e pagina de autentificare a unui instrument de observabilitate. Trei variante, toate reversibile:",
      7.0, "S", INK)
d.txt(22, 39.6, "a.  Langfuse intră în planul operațional  →  rădăcina dă 403. Cel mai simplu, cel mai auster. Se adaugă o singură cale la lista deja aplicată.", 6.8, "S", MUT)
d.txt(22, 35.0, "b.  Langfuse se mută pe o cale proprie, protejată  →  curat, dar Langfuse rescrie căi și poate cere ajustare.", 6.8, "S", MUT)
d.txt(22, 30.4, "c.  Rădăcina servește site-ul public din repozitoriu, cele 880 de linii deja scrise  →  rezolvă simultan I-01 și prima jumătate din Poarta doi.", 6.8, "S", MUT)
d.legend(18, 21, [(GOOD, "făcut sau corect"), (TEAL, "de executat de mine"),
                  (WARN, "decizie sau risc asumat"), (CRIT, "cere acordul dvs. explicit")], gap=60)

d.footer("NrgPaths Advisory Ltd  —  merge, push pe main, release și deploy rămân umane, cerute de fiecare dată. Nu apar estimări de timp: ordinea contează, nu durata.",
         "Intern  ·  25 august 2026")

d.save()
print("OK")
