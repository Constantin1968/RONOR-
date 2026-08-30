#!/usr/bin/env python3
"""Markdown -> PDF pentru raportul de constatare RONOR."""
import re, sys
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                               Spacer, Table, TableStyle, KeepTogether, PageBreak,
                               HRFlowable)

F = "/usr/share/fonts/truetype/crosextra/"
D = "/usr/share/fonts/truetype/dejavu/"
pdfmetrics.registerFont(TTFont("Sans", F + "Carlito-Regular.ttf"))
pdfmetrics.registerFont(TTFont("Sans-B", F + "Carlito-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Sans-I", F + "Carlito-Italic.ttf"))
pdfmetrics.registerFont(TTFont("Sans-BI", F + "Carlito-BoldItalic.ttf"))
pdfmetrics.registerFont(TTFont("Mono", D + "DejaVuSansMono.ttf"))
pdfmetrics.registerFont(TTFont("Mono-B", D + "DejaVuSansMono-Bold.ttf"))
pdfmetrics.registerFontFamily("Sans", normal="Sans", bold="Sans-B",
                              italic="Sans-I", boldItalic="Sans-BI")

INK      = HexColor("#28251D")
MUTED    = HexColor("#6B6A65")
FAINT    = HexColor("#9A9994")
RULE     = HexColor("#D4D1CA")
TEAL     = HexColor("#01696F")
TEAL_DK  = HexColor("#0C4E54")
CRIT     = HexColor("#A12C7B")
WARN     = HexColor("#964219")
SURF     = HexColor("#F4F3EF")
SURF2    = HexColor("#FAFAF8")
HDRBG    = HexColor("#28251D")

PW, PH = A4
LM = RM = 20 * mm
TM = 18 * mm
BM = 18 * mm
CW = PW - LM - RM

def st(name, **kw):
    base = dict(name=name, fontName="Sans", fontSize=9.4, leading=13.6,
                textColor=INK, spaceAfter=0, alignment=TA_LEFT)
    base.update(kw)
    return ParagraphStyle(**base)

S = {
 "body":  st("body", spaceAfter=6.5),
 "h1":    st("h1", fontName="Sans-B", fontSize=17, leading=21, textColor=TEAL_DK, spaceAfter=3),
 "h2":    st("h2", fontName="Sans-B", fontSize=12.6, leading=16, textColor=INK, spaceAfter=5),
 "h3":    st("h3", fontName="Sans-B", fontSize=10.4, leading=14, textColor=TEAL_DK, spaceAfter=4),
 "li":    st("li", spaceAfter=3.6, leftIndent=11, bulletIndent=1.5, firstLineIndent=0),
 "th":    st("th", fontName="Sans-B", fontSize=8.3, leading=10.8, textColor=HexColor("#FFFFFF")),
 "td":    st("td", fontSize=8.4, leading=11.2),
 "tdb":   st("tdb", fontName="Sans-B", fontSize=8.4, leading=11.2),
 "cover_t":  st("cover_t", fontName="Sans-B", fontSize=27, leading=31, textColor=INK),
 "cover_s":  st("cover_s", fontName="Sans-B", fontSize=14, leading=19, textColor=TEAL),
 "cover_s2": st("cover_s2", fontSize=11.5, leading=16, textColor=MUTED),
 "note":  st("note", fontSize=8.4, leading=12, textColor=MUTED, spaceAfter=5),
 "hr":    st("hr", fontSize=1, leading=1),
}

# ---------- inline markdown -> reportlab xml ----------
def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def inline(t):
    # protejeaza codul inline inainte de escape
    codes = []
    def keep(m):
        codes.append(m.group(1))
        return "\x00%d\x00" % (len(codes) - 1)
    t = re.sub(r"`([^`]+)`", keep, t)
    t = esc(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<![\w*])\*([^*\n]+?)\*(?![\w*])", r"<i>\1</i>", t)
    t = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)",
               r'<a href="\2" color="#01696F">\1</a>', t)
    def back(m):
        c = esc(codes[int(m.group(1))])
        return ('<font name="Mono" size="7.9" color="#0C4E54">%s</font>' % c)
    return re.sub(r"\x00(\d+)\x00", back, t)

# ---------- tabele ----------
def split_row(line):
    line = line.strip()
    if line.startswith("|"): line = line[1:]
    if line.endswith("|"): line = line[:-1]
    out, cur, i = [], "", 0
    while i < len(line):
        ch = line[i]
        if ch == "\\" and i + 1 < len(line) and line[i+1] == "|":
            cur += "|"; i += 2; continue
        if ch == "`":
            j = line.find("`", i + 1)
            if j == -1: cur += ch; i += 1; continue
            cur += line[i:j+1]; i = j + 1; continue
        if ch == "|":
            out.append(cur.strip()); cur = ""; i += 1; continue
        cur += ch; i += 1
    out.append(cur.strip())
    return out

SEV = {"critic": CRIT, "critică": CRIT, "înalt": WARN, "înaltă": WARN}

def cell_para(txt, style):
    p = Paragraph(inline(txt) if txt else "", style)
    return p

PAD = 11.0  # left+right padding in points

def _plain(t):
    return re.sub(r"[*`\[\]]", "", t)

def _tokw(t, fn, fs):
    """latimea celui mai lung token nefrangibil"""
    best = 0.0
    for tok in re.split(r"[\s]+", _plain(t)):
        if not tok:
            continue
        # punctele de frangere naturale ale reportlab: doar spatiu
        best = max(best,
                   pdfmetrics.stringWidth(tok, fn, fs),
                   pdfmetrics.stringWidth(tok, "Mono", 7.9) if "`" in t else 0.0)
    return best

def mk_table(rows):
    head, body = rows[0], rows[1:]
    n = len(head)
    body = [r + [""] * (n - len(r)) if len(r) < n else r[:n] for r in body]

    HS, BS = 8.3, 8.4
    weight, floor = [], []
    for c in range(n):
        texts = [head[c]] + [r[c] for r in body]
        full = [pdfmetrics.stringWidth(_plain(t), "Sans", BS) for t in texts]
        mx, avg = max(full), sum(full) / len(full)
        weight.append(max(24.0, 0.42 * mx + 0.58 * avg))
        tk = max([_tokw(head[c], "Sans-B", HS)] +
                 [_tokw(r[c], "Sans", BS) for r in body] + [0.0])
        floor.append(min(tk + PAD + 1.5, 0.44 * CW))

    avail = CW - sum(floor)
    if avail <= 0:
        s = CW / sum(floor)
        widths = [f * s for f in floor]
    else:
        tw = sum(weight)
        extra = [max(0.0, weight[c] / tw * CW - floor[c]) for c in range(n)]
        te = sum(extra) or 1.0
        widths = [floor[c] + avail * extra[c] / te for c in range(n)]
    s = CW / sum(widths)
    widths = [x * s for x in widths]

    data = [[cell_para(h, S["th"]) for h in head]]
    for r in body:
        row = []
        for i, cell in enumerate(r):
            stl = S["tdb"] if (i == 0 and n > 2 and re.match(r"^\*\*", cell)) else S["td"]
            row.append(cell_para(cell, stl))
        data.append(row)

    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), HDRBG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("LINEBELOW", (0, -1), (-1, -1), 0.9, HexColor("#B9B6AF")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [SURF2, SURF]),
    ]
    t.setStyle(TableStyle(cmds))
    return t

# ---------- parser ----------
def build(md):
    story = []
    lines = md.split("\n")
    i = 0
    first_h1 = True
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()

        if not s:
            i += 1; continue

        if re.match(r"^-{3,}$", s):
            story.append(Spacer(1, 3))
            story.append(HRFlowable(width="100%", thickness=0.5, color=RULE,
                                    spaceBefore=0, spaceAfter=8))
            i += 1; continue

        m = re.match(r"^(#{1,4})\s+(.*)$", s)
        if m:
            lvl, txt = len(m.group(1)), m.group(2)
            if lvl == 1:
                if not first_h1:
                    story.append(PageBreak())
                first_h1 = False
                story.append(Paragraph(inline(txt), S["h1"]))
                story.append(HRFlowable(width="100%", thickness=1.6, color=TEAL,
                                        spaceBefore=3, spaceAfter=10))
            elif lvl == 2:
                story.append(Spacer(1, 7))
                story.append(Paragraph(inline(txt), S["h2"]))
                story.append(HRFlowable(width="100%", thickness=0.5, color=RULE,
                                        spaceBefore=1, spaceAfter=7))
            else:
                story.append(Spacer(1, 5))
                story.append(Paragraph(inline(txt), S["h3"]))
            i += 1; continue

        # tabel
        if s.startswith("|") and i + 1 < len(lines) and \
           re.match(r"^\|[\s:|-]+\|?$", lines[i+1].strip()):
            rows = [split_row(s)]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip())); i += 1
            story.append(Spacer(1, 2))
            story.append(mk_table(rows))
            story.append(Spacer(1, 9))
            continue

        # lista
        m = re.match(r"^(\d+)\.\s+(.*)$", s)
        m2 = re.match(r"^[-*]\s+(.*)$", s)
        if m or m2:
            items = []
            while i < len(lines):
                t = lines[i].strip()
                mm_ = re.match(r"^(\d+)\.\s+(.*)$", t)
                mm2 = re.match(r"^[-*]\s+(.*)$", t)
                if mm_:
                    items.append((mm_.group(1) + ".", mm_.group(2))); i += 1
                elif mm2:
                    items.append(("\u2022", mm2.group(1))); i += 1
                elif t and not t.startswith("|") and not t.startswith("#") \
                     and not re.match(r"^-{3,}$", t) and items:
                    items[-1] = (items[-1][0], items[-1][1] + " " + t); i += 1
                else:
                    break
            for b, txt in items:
                story.append(Paragraph(inline(txt), S["li"], bulletText=b))
            story.append(Spacer(1, 5))
            continue

        # paragraf
        buf = [s]; i += 1
        while i < len(lines):
            t = lines[i].strip()
            if not t or t.startswith("|") or t.startswith("#") \
               or re.match(r"^-{3,}$", t) or re.match(r"^([-*]|\d+\.)\s", t):
                break
            buf.append(t); i += 1
        txt = " ".join(buf)
        style = S["note"] if txt.startswith("*") and txt.endswith("*") else S["body"]
        if style is S["note"]:
            txt = txt.strip("*")
        story.append(Paragraph(inline(txt), style))
    return story

# ---------- cover ----------
def cover():
    o = [Spacer(1, 28 * mm)]
    o.append(Paragraph("RAPORT DE ORIENTARE", S["cover_t"]))
    o.append(Spacer(1, 5))
    o.append(HRFlowable(width="46%", thickness=2.4, color=TEAL,
                        spaceBefore=2, spaceAfter=13, hAlign="LEFT"))
    o.append(Paragraph("RONOR &mdash; Sovereign Intelligence Operating Runtime", S["cover_s"]))
    o.append(Spacer(1, 3))
    o.append(Paragraph("Unde sunt, ce am, cum procedez", S["cover_s2"]))
    o.append(Spacer(1, 15 * mm))

    rows = [
        ["Obiect", "Planul de interfe\u021be RONOR, cele trei gazde, arhiva laptopului, arhiva Perplexity, paritatea cu reperul Grok Bot"],
        ["Data", "25 august 2026"],
        ["Revizia de referin\u021b\u0103", "44f379870be43b617c4838cba0f066c053ce2b1a (origin/main)"],
        ["Depozit", "github.com/Constantin1968/RONOR-"],
        ["Suprafe\u021be examinate", "Site public, Consol\u0103 de operator, Interfa\u021b\u0103 de arhitect, RONOR Bot, tablou de bord live"],
        ["Gazde examinate", "4 din 4 \u2014 DigitalOcean primar, Hetzner secundar, Contabo, bastion DO"],
        ["Regim", "Read-only \u2014 niciun merge, push, release sau deploy"],
        ["Clasificare", "Intern \u2014 con\u021bine referin\u021be la expuneri neremediate"],
    ]
    data = [[Paragraph("<b>%s</b>" % esc(a), S["td"]), Paragraph(esc(b), S["td"])]
            for a, b in rows]
    t = Table(data, colWidths=[46 * mm, CW - 46 * mm], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, -1), 0),
        ("LEFTPADDING", (1, 0), (1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 0), (-1, -2), 0.4, RULE),
        ("TEXTCOLOR", (0, 0), (0, -1), MUTED),
    ]))
    o.append(t)
    o.append(Spacer(1, 16 * mm))
    o.append(HRFlowable(width="100%", thickness=0.5, color=RULE, spaceAfter=7))
    o.append(Paragraph(
        "Toate valorile din acest raport au fost m\u0103surate direct, prin sondare live, "
        "interogare de protocol cu porturi de control, \u0219i citire direct\u0103 a codului surs\u0103. "
        "Nicio valoare de secret nu este afi\u0219at\u0103. Nicio opera\u021biune de scriere "
        "nu a fost efectuat\u0103 pe depozit sau pe sistemele de produc\u021bie.", S["note"]))
    o.append(PageBreak())
    return o

def deco(cv, doc):
    cv.saveState()
    cv.setFont("Sans", 7.4)
    cv.setFillColor(FAINT)
    if doc.page > 1:
        cv.setStrokeColor(RULE); cv.setLineWidth(0.4)
        cv.line(LM, PH - TM + 5.5 * mm, PW - RM, PH - TM + 5.5 * mm)
        cv.drawString(LM, PH - TM + 7.5 * mm,
                      "RONOR \u2014 Raport de orientare \u00b7 25 august 2026")
        cv.drawRightString(PW - RM, PH - TM + 7.5 * mm, "Intern")
        cv.setStrokeColor(RULE)
        cv.line(LM, BM - 4 * mm, PW - RM, BM - 4 * mm)
        cv.drawString(LM, BM - 9 * mm, "NrgPaths Advisory Ltd")
        cv.drawRightString(PW - RM, BM - 9 * mm, "Pagina %d" % doc.page)
    else:
        cv.setFillColor(TEAL)
        cv.rect(0, PH - 9 * mm, PW, 9 * mm, stroke=0, fill=1)
        cv.setFillColor(FAINT)
        cv.drawRightString(PW - RM, BM - 9 * mm, "25 august 2026")
    cv.restoreState()

def main(src, out):
    md = open(src, encoding="utf-8").read()
    # taie blocul de titlu deja randat pe copert\u0103
    m = re.search(r"^## 1\. Scopul", md, re.M)
    body = md[m.start():] if m else md
    doc = BaseDocTemplate(out, pagesize=A4,
                          leftMargin=LM, rightMargin=RM,
                          topMargin=TM, bottomMargin=BM,
                          title="RONOR \u2014 Raport de orientare, 25 august 2026",
                          author="NrgPaths Advisory Ltd",
                          subject="Raport de orientare RONOR",
                          creator="NrgPaths Advisory Ltd")
    fr = Frame(LM, BM, CW, PH - TM - BM, id="n",
               leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="all", frames=[fr], onPage=deco)])
    story = cover() + build(body)
    doc.build(story)
    print("OK ->", out)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
