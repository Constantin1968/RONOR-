"""RONOR Bot — the human operator's interface to the agent.

The bot itself is only a Telegram token; everything it "knows" lives here:
commands map to the agent's capabilities, free-text questions are answered
from a local knowledge base built from the repo docs (README, doctrine).
No external LLM: answers are grounded in what this system actually does.

Decision boundary: the bot can *show* and *propose* anything, and it can
record a human's nomination (``/nomineaza``) — that is the human deciding.
It never nominates on its own.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from energy_trading.agent import CrossBorderAgent
from energy_trading.config import Settings
from energy_trading.interconnectors import INTERCONNECTORS
from energy_trading.ops_intake import load_ntc_csv
from energy_trading.scheduler import JobRunner, daily_brief, latest_file
from energy_trading.sovereignty import EVIDENCE_OPERATOR
from energy_trading.store import StateStore

ROOT = Path(__file__).resolve().parent.parent.parent
log = logging.getLogger("energy_trading.operator")
KNOWLEDGE_FILES = [
    ROOT / "README.md",
    ROOT / "docs" / "SOVEREIGNTY_DOCTRINE.md",
    ROOT / "deploy" / "README.md",
]
EAST = {"RO", "UA", "MD", "BG", "RS", "HU"}

HELP = """Vorbește-mi normal. Exemple:

„RONOR, activează agentul de trading”
„cum stau lucrurile azi?”  ·  „ce avem mâine?”
„ce trebuie să autorizez?”  ·  „autorizez tot”  ·  „autorizez XB-0001 XB-0002”
„arată-mi dashboard-ul”  ·  „cum e vremea?”  ·  „ce capacitate avem pe 14.09?”
„skip UA-MD”  ·  postezi tabelul NTC (.xlsx) sau prețurile — le iau singur
„cât am făcut ieri?”  ·  „P/L pe 13.09”  — raportul P/L Digital Twin (prețuri citite din OPCOM/OREE)
postezi foaia ta zilnică (Capacity won / CBC / Bid Limit / Nominated / Profit, .xlsx sau .csv) — o iau ca poziție reală

Comenzi scurte, dacă preferi: /azi /maine /pl /autorizez /activeaza /dashboard /ajutor"""


def _day_arg(arg: str, tz: ZoneInfo, default_offset_days: int = 0) -> str:
    """Accept ISO (2026-09-13), dd.mm[.yyyy], 'azi', 'maine' → ISO date."""
    now = datetime.now(tz).date()
    a = (arg or "").strip().lower()
    if not a or a == "azi":
        return (now + timedelta(days=default_offset_days)).isoformat()
    if a in ("maine", "mâine"):
        return (now + timedelta(days=1)).isoformat()
    m = re.fullmatch(r"(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?", a)
    if m:
        y = (
            now.year
            if not m.group(3)
            else (int(m.group(3)) if len(m.group(3)) == 4 else 2000 + int(m.group(3)))
        )
        return datetime(y, int(m.group(2)), int(m.group(1)), tzinfo=tz).date().isoformat()
    try:
        return datetime.fromisoformat(a).date().isoformat()
    except ValueError:
        return (now + timedelta(days=default_offset_days)).isoformat()


class KnowledgeBase:
    """Heading-delimited sections from the repo docs, ranked by keyword overlap."""

    def __init__(self, files: list[Path] | None = None):
        self.sections: list[tuple[str, str]] = []
        for f in files or KNOWLEDGE_FILES:
            if not f.exists():
                continue
            title, buf = f.stem, []
            for line in f.read_text(encoding="utf-8").splitlines():
                if line.startswith("#"):
                    if buf:
                        self.sections.append((title, "\n".join(buf).strip()))
                    title, buf = line.lstrip("# ").strip(), []
                else:
                    buf.append(line)
            if buf:
                self.sections.append((title, "\n".join(buf).strip()))

    @staticmethod
    def _tokens(text: str) -> set[str]:
        return {
            t for t in re.findall(r"[a-zăâîșțA-ZĂÂÎȘȚ0-9\-]{3,}", text.lower()) if t not in _STOP
        }

    def retrieve(self, question: str, k: int = 3) -> list[tuple[str, str, float]]:
        """Top-k (title, body, score) sections by keyword overlap; empty if nothing matches."""
        q = self._tokens(question)
        if not q:
            return []
        scored = []
        for title, body in self.sections:
            words = self._tokens(title + " " + body)
            if not words:
                continue
            hit = len(q & words) + 2 * len(q & self._tokens(title))
            if hit >= 1:
                scored.append((title, body, float(hit)))
        scored.sort(key=lambda x: -x[2])
        return scored[:k]

    def answer(self, question: str, max_chars: int = 900) -> str:
        top = self.retrieve(question, k=1)
        if not top:
            return ""
        title, body, _ = top[0]
        body = re.sub(r"```.*?```", "", body, flags=re.DOTALL).strip()
        body = re.sub(r"\n{3,}", "\n\n", body)
        return f"📖 {title}\n{body[:max_chars]}{'…' if len(body) > max_chars else ''}"


class OllamaAnswerer:
    """Grounded Q&A on the sovereign node's Ollama: retrieved docs + live state → answer.

    The model only sees sections from this repo's docs plus a short live
    snapshot; it is instructed to refuse when the context does not cover the
    question. Any transport failure falls back to the keyword answer, so the
    bot never goes silent because a GPU box is busy.
    """

    SYSTEM = (
        "Ești RONOR, asistentul operatorului de trading cross-border cu România ca hub regional. "
        "Răspunzi în română, concis (max 8 rânduri), doar pe baza CONTEXTULUI primit. "
        "Dacă contextul nu acoperă întrebarea, spui exact: 'Nu am informația asta în documentație.' "
        "Nu inventezi cifre. Nu recomanzi nominalizări — doar omul nominalizează."
    )

    def __init__(self, url: str, model: str, timeout: float = 60.0, post=None):
        self.url = url
        self.model = model
        self.timeout = timeout
        self._post = post or self._http_post

    @property
    def enabled(self) -> bool:
        return bool(self.url and self.model)

    def _http_post(self, path: str, payload: dict) -> dict:
        import json
        from urllib.request import Request, urlopen

        req = Request(
            f"{self.url}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def answer(self, question: str, sections: list[tuple[str, str, float]], live: str) -> str:
        if not self.enabled or not sections:
            return ""
        context = "\n\n".join(
            f"## {t}\n{re.sub(r'```.*?```', '', b, flags=re.DOTALL).strip()[:1800]}"
            for t, b, _ in sections
        )
        user = f"CONTEXT:\n{context}\n\nSTARE LIVE:\n{live}\n\nÎNTREBARE: {question}"
        try:
            out = self._post(
                "/api/chat",
                {
                    "model": self.model,
                    "stream": False,
                    "options": {"temperature": 0.1},
                    "messages": [
                        {"role": "system", "content": self.SYSTEM},
                        {"role": "user", "content": user},
                    ],
                },
            )
            text = (out.get("message") or {}).get("content", "").strip()
            return f"🧠 {text}" if text else ""
        except Exception as exc:  # noqa: BLE001 — degrade to keyword answer
            log.warning("ollama unavailable (%s): falling back to keyword answer", exc)
            return ""


_STOP = {
    "este",
    "sunt",
    "care",
    "cum",
    "pentru",
    "prin",
    "din",
    "the",
    "and",
    "with",
    "what",
    "how",
    "does",
    "poti",
    "poți",
    "vreau",
    "despre",
    "unde",
    "cand",
    "când",
    "sau",
    "dar",
}


class OperatorBot:
    def __init__(
        self,
        agent: CrossBorderAgent,
        runner: JobRunner,
        store: StateStore,
        settings: Settings,
        knowledge: KnowledgeBase | None = None,
    ):
        self.agent = agent
        self.runner = runner
        self.store = store
        self.settings = settings
        self.tz = ZoneInfo(settings.timezone)
        self.kb = knowledge or KnowledgeBase()
        self.current_operator = ""
        self.llm = OllamaAnswerer(
            settings.ollama_url, settings.ollama_model, settings.ollama_timeout
        )
        self.commands: dict[str, Callable[[str], str]] = {
            "azi": self.cmd_day,
            "maine": self.cmd_tomorrow,
            "mâine": self.cmd_tomorrow,
            "zi": self.cmd_day,
            "activeaza": self.cmd_activate,
            "activează": self.cmd_activate,
            "opreste": self.cmd_stop,
            "oprește": self.cmd_stop,
            "autorizez": self.cmd_authorize,
            "dashboard": self.cmd_dashboard,
            "start": self.cmd_help,
            "help": self.cmd_help,
            "ajutor": self.cmd_help,
            "status": self.cmd_status,
            "hub": self.cmd_hub,
            "ntc": self.cmd_ntc,
            "meteo": self.cmd_weather,
            "weather": self.cmd_weather,
            "granite": self.cmd_borders,
            "granițe": self.cmd_borders,
            "propuneri": self.cmd_run,
            "run": self.cmd_run,
            "book": self.cmd_book,
            "nomineaza": self.cmd_nominate,
            "nominează": self.cmd_nominate,
            "deconteaza": self.cmd_settle,
            "decontează": self.cmd_settle,
            "suveranitate": self.cmd_sovereignty,
            "alerte": self.cmd_alerts,
            "claims": self.cmd_claims,
            "doctrina": self.cmd_doctrine,
            "pl": self.cmd_pnl,
            "pnl": self.cmd_pnl,
            "profit": self.cmd_pnl,
            "preturi": self.cmd_fetch,
            "prețuri": self.cmd_fetch,
            "intreaba": self.ask,  # explicit knowledge lookup (used by the RONOR tool loop)
            "doctrină": self.cmd_doctrine,
        }

    # -- dispatch ------------------------------------------------------
    def handle(self, text: str, who: str = "") -> str:
        """``who`` is the human behind the message (Telegram name, Tailscale login, …)."""
        self.current_operator = who
        text = (text or "").strip()
        if text.startswith("/"):
            head, _, arg = text[1:].partition(" ")
            name = head.split("@")[0].lower()  # "/hub@RONORBot" → "hub"
            fn = self.commands.get(name)
            if not fn:
                return "Nu cunosc comanda. Scrie /azi sau /maine."
            return self._safe(name, fn, arg.strip())
        intent, arg = self.intent(text)
        if intent:
            return self._safe(intent, self.commands[intent], arg)
        return self.ask(text)

    def route(self, text: str) -> str | None:
        """Deterministic routing only: the command this text maps to, or ``None``.

        Used by the RONOR model loop to run the obvious tool *before* asking the
        model — routing in Romanian is something we already do exactly.
        """
        text = (text or "").strip()
        if text.startswith("/"):
            head, _, arg = text[1:].partition(" ")
            name = head.split("@")[0].lower()
            return f"/{name} {arg.strip()}".strip() if name in self.commands else None
        intent, arg = self.intent(text)
        return f"/{intent} {arg}".strip() if intent else None

    def _safe(self, name: str, fn: Callable[[str], str], arg: str) -> str:
        try:
            return fn(arg)
        except Exception as exc:  # noqa: BLE001 — the bot must always answer
            return f"⚠️ {name} a eșuat: {str(exc)[:200]}"

    def intent(self, text: str) -> tuple[str | None, str]:
        """Natural language → (command, argument). 'RONOR, activează agentul' → ('activeaza', '')."""
        t = re.sub(r"^\s*(ronor|@ronorbot)[\s,:!]*", "", text, flags=re.IGNORECASE).strip()
        low = t.lower()
        date_m = re.search(r"\b(\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|\d{4}-\d{2}-\d{2})\b", low)
        rel_m = re.search(r"\b(azi|m[âa]ine)\b", low)
        day = date_m.group(1) if date_m else (rel_m.group(1) if rel_m else "")
        ids = " ".join(re.findall(r"xb-\d+", low, flags=re.IGNORECASE))

        def has(*words: str) -> bool:
            return any(re.search(rf"\b{w}", low) for w in words)

        # Knowledge questions go to the docs, not to a command.
        if has("ce (este|e|[îi]nseamn[ăa])", "cum func[țt]ion", "explic[ăa]", "de ce", "ce rol"):
            return None, ""

        if has("activ", "porne[sș]te", "start", "treze[sș]te", "d[ăa]-i drumul", "lanseaz"):
            return "activeaza", ""
        if has("opre[sș]te", "dezactiv", "stop", "pauz"):
            return "opreste", ""
        if has(
            "autoriz",
            "confirm",
            "nomin",
            "aprob",
            "semnez",
            "ce trebuie s[ăa] (autoriz|aprob|confirm)",
        ) or (ids and has("ok", "da", "yes", "merge", "go", "hai")):
            if ids:
                return "autorizez", ids
            if has("tot", "toate", "all", "pe toate"):
                return "autorizez", "tot"
            return "autorizez", ""
        if has("dashboard", "panou", "ecran", "tablou"):
            return "dashboard", ""
        if has(
            "p/l",
            "p&l",
            "pnl",
            "profit",
            "c[âa]t am (f[ăa]cut|c[âa][sș]tigat|pierdut)",
            "twin",
            "rezultat",
            "decont",
            "ieri",
        ):
            return "pl", day or ("ieri" if has("ieri") else "")
        if has("ia prețurile", "ia preturile", "citește prețurile", "opcom", "oree"):
            return "preturi", day
        if has("meteo", "vreme", "vremea", "prognoz"):
            return "meteo", ""
        if has("capacit", "ntc", "atc"):
            return "ntc", day
        if has("basis", "hub", "wheeling", "vecin"):
            return "hub", day
        if has("book", "portofoliu", "tranzac[țt]ii"):
            return "book", ""
        if has("alert"):
            return "alerte", ""
        if has("suveran", "dependen", "import net"):
            return "suveranitate", ""
        if has("status", "stare", "merge", "func[țt]ione", "e[sș]ti acolo", "tr[ăa]ie[sș]ti"):
            return "status", ""
        if has("m[âa]ine"):
            return "maine", day
        if has(
            "azi",
            "ast[ăa]zi",
            "cum stau",
            "cum st[ăa]m",
            "cum st[ăa]",
            "cum e ziua",
            "cum arat[ăa]",
            "ziua",
            "ziu[ăa]",
            "situa[țt]i",
            "raport",
            "ce avem",
            "ce facem",
            "ce propui",
            "ce zici",
            "hai s[ăa] vedem",
        ) or (day and not low.rstrip().endswith("?")):
            return "azi", day
        if has("ajutor", "help", "ce po[țt]i", "ce [sș]tii"):
            return "ajutor", ""
        return None, ""

    def ask(self, question: str) -> str:
        """Free-text Q&A: sovereign LLM grounded in docs + live state, else keyword answer."""
        sections = self.kb.retrieve(question, k=3)
        if sections and self.llm.enabled:
            reply = self.llm.answer(question, sections, self._live_context())
            if reply:
                return reply
        return self.kb.answer(question) or (
            "Nu am găsit nimic în documentație pentru asta. Încearcă /ajutor sau reformulează."
        )

    def _live_context(self) -> str:
        s = self.agent.summary()
        st = self.runner.status()
        parts = [
            (
                f"book: {s['open_trades']} tranzacții deschise, {s['total_volume_mw']} MW, "
                f"P&L așteptat €{s['total_expected_pnl']:,.0f}"
            ),
            "ultimele job-uri: "
            + (", ".join(f"{k} {v}" for k, v in st["last_run"].items()) or "—"),
        ]
        alerts = self.store.read("alerts", limit=3)
        if alerts:
            parts.append("alerte recente: " + " | ".join(a["message"][:100] for a in alerts))
        return "\n".join(parts)

    # -- commands ------------------------------------------------------
    def cmd_day(self, arg: str) -> str:
        """One message for the day: closed/thin borders, decisions, proposals."""
        day = _day_arg(arg, self.tz, default_offset_days=0)
        out = self.runner.run("hub_run", day)
        if out["status"] != "ok":
            return f"⚠️ Nu am putut rula ziua {day}: {out['result'].get('error')}"
        return daily_brief(out["result"], self.agent.book)

    def cmd_tomorrow(self, arg: str) -> str:
        return self.cmd_day(arg or "maine")

    def cmd_activate(self, _: str) -> str:
        was = self.runner.running
        self.runner.start()
        st = self.runner.status()
        sched = ", ".join(f"{k} la {v}" for k, v in st["schedule"].items())
        head = "Agentul era deja activ." if was else "✅ Agentul de trading e activ."
        return (
            f"{head}\nRulez singur în fiecare zi: {sched} (ora București).\n"
            f"Îți scriu aici ce e deschis, ce e închis și ce propun. Tu doar autorizezi.\n"
            f"Dashboard: {self.settings.public_url or 'http://localhost:8000'}"
        )

    def cmd_stop(self, _: str) -> str:
        self.runner.stop()
        return "⏸ Agentul e în pauză. Nu mai rulez nimic automat; comenzile manuale merg în continuare."

    def cmd_dashboard(self, _: str) -> str:
        url = self.settings.public_url or "http://localhost:8000"
        pending = [t for t in self.agent.book if t.status == "proposed"]
        return (
            f"🖥 Dashboard: {url}\n"
            f"Acolo vezi ziua, ce e de autorizat ({len(pending)} propuneri acum) și poți vorbi cu mine."
        )

    def cmd_authorize(self, arg: str) -> str:
        """'ce trebuie să autorizez' → list; 'autorizez tot' / IDs → nominate."""
        pending = [t for t in self.agent.book if t.status == "proposed"]
        arg = (arg or "").strip().lower()
        if not pending:
            return "Nu ai nimic de autorizat acum. Scrie /azi ca să rulez ziua."
        if arg in ("tot", "toate", "all"):
            return self.cmd_nominate(" ".join(t.id for t in pending))
        if re.search(r"xb-\d+", arg):
            return self.cmd_nominate(arg)
        by_dir: dict[str, list] = {}
        for t in pending:
            by_dir.setdefault(f"{t.from_zone}→{t.to_zone} {t.delivery_start:%d.%m}", []).append(t)
        lines = [
            f"🔏 De autorizat: {len(pending)} propuneri, €{sum(t.expected_pnl for t in pending):,.0f} așteptat"
        ]
        for k, ts in by_dir.items():
            lines.append(
                f"• {k}: {len(ts)}h, {sum(t.volume_mw for t in ts):.0f} MWh, €{sum(t.expected_pnl for t in ts):,.0f}"
                f" — {' '.join(t.id for t in ts[:4])}{' …' if len(ts) > 4 else ''}"
            )
        lines.append("Spune „RONOR, autorizez tot” sau „autorizez XB-0001 XB-0002”.")
        return "\n".join(lines)

    def cmd_help(self, _: str) -> str:
        return HELP

    def cmd_pnl(self, arg: str) -> str:
        """P/L Digital Twin for a delivered day (default yesterday)."""
        a = (arg or "").strip().lower()
        day = _day_arg("" if a == "ieri" else a, self.tz, default_offset_days=-1)
        out = self.runner.run("pnl", day)
        if out["status"] != "ok":
            return f"⚠️ Nu am putut calcula P/L pentru {day}: {out['result'].get('error')}"
        return out["result"]["text"]

    def cmd_fetch(self, arg: str) -> str:
        """Pull published prices now (OPCOM RO, OREE UA) for a day, or today+tomorrow."""
        day = _day_arg(arg, self.tz) if arg else None
        out = self.runner.run("fetch", day)
        if out["status"] != "ok":
            return f"⚠️ Sursele nu au răspuns: {out['result'].get('error')}"
        r = out["result"]
        lines = [f"✅ luat: {x}" for x in r["fetched"]] + [
            f"⏳ nepublicat încă: {x}" for x in r["pending"]
        ]
        if r.get("mismatches"):
            lines.append(f"⚠️ {r['mismatches']} valori din fișier corectate după sursă")
        return "\n".join(lines) if lines else "Nimic de luat: prețurile zilei sunt deja complete."

    def cmd_status(self, _: str) -> str:
        st = self.runner.status()
        up = st.get("uptime_minutes")
        up_txt = f", de {up // 60}h{up % 60:02d}" if up is not None else ""
        nxt = st.get("next", {})
        lines = [
            f"{'🟢 Veghez 24/7' if st['running'] else '⏸ Oprit'} ({st['timezone']}{up_txt})",
            "Program: " + ", ".join(f"{k} {v}" for k, v in st["schedule"].items()),
            "Urmează: "
            + ", ".join(
                f"{k} {nxt[k]}"
                for k in ("fetch", "hub_run", "evening", "pnl", "weather")
                if k in nxt
            )
            + (f"; gate {nxt['gate']}" if "gate" in nxt else ""),
            "Ultima rulare: " + (", ".join(f"{k} {v}" for k, v in st["last_run"].items()) or "—"),
            f"Veghez {st.get('watching', 0)} fișiere/override-uri; date noi → ziua refăcută în ≤1 min",
            f"Restaurat la pornire: {st['restored']['trades']} tranzacții, {st['restored']['claims']} claims",
            f"Telegram alerte: {'da' if st['telegram'] else 'nu'}",
            "LLM suveran: "
            + (
                f"Ollama {self.llm.model} @ {self.llm.url}"
                if self.llm.enabled
                else "dezactivat (răspunsuri din documentație)"
            ),
        ]
        s = self.agent.summary()
        lines.append(
            f"Book: {s['open_trades']} deschise, {s['total_volume_mw']} MW, P&L așteptat €{s['total_expected_pnl']:,.0f}"
        )
        if st.get("retries"):
            lines.append(
                "⚠️ Reîncerc: "
                + "; ".join(
                    f"{n} (#{r['attempt']} la {r['due']})" for n, r in st["retries"].items()
                )
            )
        recent = st.get("recent", [])[-3:]
        if recent:
            lines.append(
                "Job-uri recente: "
                + "; ".join(f"{r['job']} {r['status']} {r['seconds']}s" for r in recent)
            )
        return "\n".join(lines)

    def cmd_hub(self, arg: str) -> str:
        day = _day_arg(arg, self.tz, default_offset_days=1)
        snap = self._brief(day, "hub")
        if not snap:
            out = self.runner.run("hub_run", day)
            if out["status"] != "ok":
                return f"⚠️ Nu am putut construi hub-ul pentru {day}: {out['result'].get('error')}"
            snap = self._brief(day, "hub")
        zones = snap["summary"]["zones"]
        run = self._brief(day, "run") or {}
        src = (
            "date reale"
            if run.get("evidence_level") == EVIDENCE_OPERATOR
            else "⚠️ prețuri simulate — postează prețurile zilei pentru cifre reale"
        )
        lines = [f"🏛 Hub RO — {day} ({src})"]
        for z, v in sorted(zones.items(), key=lambda kv: kv[1]["mean_basis"]):
            arrow = "⬇️ import" if v["mean_basis"] < 0 else "⬆️ export"
            lines.append(
                f"{z}: basis mediu {v['mean_basis']:+.1f} €/MWh, {v['import_hours']}h import / {v['export_hours']}h export → {arrow}"
            )
        best = snap["summary"].get("best_wheel")
        if best:
            lines.append(
                f"🔁 Wheeling top: {best['from_zone']}→RO→{best['to_zone']} ora {best['hour']:02d}, "
                f"net {best['net_spread']:.1f} €/MWh × {best['capacity_mw']:.0f} MW ≈ €{best['expected_profit_eur']:,.0f}"
            )
        lines.append(
            f"{snap['summary']['wheeling_count']} oportunități de wheeling, total așteptat €{snap['summary']['wheeling_expected_eur']:,.0f}"
        )
        return "\n".join(lines)

    def cmd_ntc(self, arg: str) -> str:
        day = _day_arg(arg, self.tz, default_offset_days=1)
        path = latest_file(self.settings.data_dir, "ntc", day)
        if not path:
            return "Nu am niciun fișier NTC în data/. Postează .xlsx-ul aici și îl ingerez."
        avail = load_ntc_csv(str(path))
        lines = [f"🔌 ATC {path.stem.replace('ntc_', '')} (din {path.name})"]
        for border, hours in sorted(avail.items()):
            vals = list(hours.values())
            if not vals:
                continue
            zero = sum(1 for v in vals if v <= 0)
            lines.append(
                f"{border}: min {min(vals):.0f} / medie {sum(vals) / len(vals):.0f} / max {max(vals):.0f} MW"
                + (f", {zero}h la 0" if zero else "")
            )
        return "\n".join(lines)

    def cmd_weather(self, _: str) -> str:
        files = self.store.list_briefs()
        weather = [f for f in files if f.endswith("_weather.json")]
        if not weather:
            out = self.runner.run("weather")
            if out["status"] != "ok":
                return f"⚠️ Meteo indisponibil: {out['result'].get('error')}"
            weather = [f for f in self.store.list_briefs() if f.endswith("_weather.json")]
        name = weather[-1]
        brief = self.store.load(f"briefs/{name[:-5]}")
        lines = [f"🌤 Meteo {name.split('_')[0]} (Open-Meteo, {brief['days']} zile)"]
        for c, cf in sorted(brief["countries"].items()):
            if cf["status"] != "ok" or not cf["daily"]:
                lines.append(f"{c}: ⚠️ {cf.get('error', 'fără date')[:60]}")
                continue
            d = cf["daily"][0]
            lines.append(
                f"{c}: {d['temp_mean']:.0f}°C, vânt {d['wind100_mean_kmh']:.0f} km/h, solar {d['solar_sum_mj']:.0f} MJ → cerere {d['demand']}, eolian {d['wind']}, solar {d['solar']}"
            )
        if brief.get("hub_read"):
            lines.append("Lectură hub:")
            lines += [f"• {r}" for r in brief["hub_read"][:6]]
        return "\n".join(lines)

    def cmd_borders(self, _: str) -> str:
        lines = ["🗺 Granițe — hub RO și est"]
        for ic in INTERCONNECTORS:
            if ic.from_zone in EAST and ic.to_zone in EAST:
                lines.append(
                    f"{ic.id}: {ic.capacity_mw:.0f} MW, {ic.coupling.value}, tarif {ic.tariff_eur_mwh:.1f} €/MWh, pierderi {ic.loss_pct:.1f}%"
                    + (f" ({ic.tso})" if ic.tso else "")
                )
        lines.append(f"Total în registru: {len(INTERCONNECTORS)} interconectori europeni.")
        return "\n".join(lines)

    def cmd_run(self, arg: str) -> str:
        day = _day_arg(arg, self.tz, default_offset_days=1)
        out = self.runner.run("hub_run", day)
        if out["status"] != "ok":
            return f"⚠️ Rularea a eșuat: {out['result'].get('error')}"
        r = out["result"]
        src = (
            "date reale"
            if r["evidence"] == EVIDENCE_OPERATOR
            else "simulare (lipsesc prețuri reale)"
        )
        fresh = [
            t
            for t in self.agent.book
            if t.status == "proposed" and t.delivery_start.date().isoformat() == day
        ]
        fresh.sort(key=lambda t: -t.expected_pnl)
        lines = [
            f"⚙️ Rulare {day} — {src}",
            f"NTC: {r['ntc'] or '—'}"
            + (" (⚠️ ultimul disponibil, nu al zilei)" if r.get("ntc_fallback") else "")
            + f" · prețuri: {r['prices'] or '—'}",
        ]
        lines += [f"🚫 {d}" for d in r.get("decisions", [])]
        lines += [f"🟠 {a['message']}" for a in r.get("alerts", []) if a["rule"] == "thin_cbc"]
        if r["trades_proposed"]:
            lines.append(
                f"{r['trades_proposed']} propuneri noi, P&L așteptat €{r['expected_pnl_eur']:,.0f}"
            )
        else:
            lines.append(
                f"0 propuneri noi — book-ul are deja {len(fresh)} propuse pentru {day}"
                if fresh
                else "0 propuneri: niciun spread nu acoperă transportul + limitele de risc"
            )
        for t in fresh[:8]:
            lines.append(
                f"{t.id} {t.from_zone}→{t.to_zone} ora {t.delivery_start.hour:02d}: {t.volume_mw:.0f} MW, "
                f"{t.buy_price:.1f}→{t.sell_price:.1f}, net €{t.expected_pnl:,.0f}"
            )
        if fresh:
            lines.append("Confirmă cu: /nomineaza " + " ".join(t.id for t in fresh[:3]))
        return "\n".join(lines)

    def cmd_book(self, _: str) -> str:
        if not self.agent.book:
            return "Book gol. /propuneri pentru a rula agentul."
        by_status: dict[str, list] = {}
        for t in self.agent.book:
            by_status.setdefault(t.status, []).append(t)
        lines = ["📒 Book"]
        for status, ts in by_status.items():
            mw = sum(t.volume_mw for t in ts)
            pnl = sum(t.expected_pnl for t in ts)
            lines.append(f"{status}: {len(ts)} tranzacții, {mw:.0f} MW, €{pnl:,.0f}")
        lines.append("Ultimele:")
        for t in self.agent.book[-6:]:
            lines.append(
                f"{t.id} [{t.status}] {t.from_zone}→{t.to_zone} {t.delivery_start:%d.%m %H}h {t.volume_mw:.0f} MW €{t.expected_pnl:,.0f}"
            )
        return "\n".join(lines)

    def cmd_nominate(self, arg: str) -> str:
        ids = [x.upper() for x in re.findall(r"XB-\d+", arg.upper())]
        if not ids:
            return "Folosește: /nomineaza XB-0001 XB-0002"
        done = self.agent.nominate(
            ids, evidence_level=EVIDENCE_OPERATOR, by=self.current_operator or "operator"
        )
        self._persist()
        missing = sorted(set(ids) - {t.id for t in done})
        who = f" — autorizat de {self.current_operator}" if self.current_operator else ""
        lines = [
            f"✅ Nominalizate {len(done)}: {', '.join(t.id for t in done)}{who}"
            if done
            else "Nimic nominalizat."
        ]
        if missing:
            lines.append(f"Nu am găsit / nu erau 'proposed': {', '.join(missing)}")
        return "\n".join(lines)

    def cmd_settle(self, _: str) -> str:
        lines_, total = self.agent.settle_book()
        self._persist()
        if not lines_:
            return "Nimic de decontat (niciun trade nominalizat)."
        return f"💶 Decontate {len(lines_)} tranzacții, net realizat €{total:,.2f}"

    def cmd_sovereignty(self, _: str) -> str:
        sov = self.agent.sovereignty(self.settings.home_zone)
        b, e = sov["balance"], sov["energy"]
        lines = [
            f"🇷🇴 Suveranitate {b['home_zone']}",
            f"Import {b['imports_mw']:.0f} MW · export {b['exports_mw']:.0f} MW · tranzit {b['transit_mw']:.0f} MW → net {b['net_mw']:+.0f} MW",
            f"Dependență de import: {b['import_dependence']:.0%}",
            "Pe granițe: "
            + (", ".join(f"{k} {v:.0f} MW" for k, v in b["per_border_mw"].items()) or "—"),
            f"Energie: {e.get('total_mwh', 0):,.0f} MWh",
        ]
        lines += [f"⚠️ {f}" for f in b.get("flags", [])]
        return "\n".join(lines)

    def cmd_alerts(self, arg: str) -> str:
        n = int(arg) if arg.isdigit() else 8
        items = self.store.read("alerts", limit=n)
        if not items:
            return "Nicio alertă înregistrată."
        icons = {"critical": "🔴", "warning": "🟠", "info": "🔵"}
        return "🔔 Alerte\n" + "\n".join(
            f"{icons.get(a['level'], '•')} {a['ts'][11:16]} {a['message'][:140]}" for a in items
        )

    def cmd_claims(self, arg: str) -> str:
        n = int(arg) if arg.isdigit() else 8
        entries = self.agent.claims.entries[-n:]
        if not entries:
            return "Registrul e gol."
        return "📜 Registrul afirmațiilor\n" + "\n".join(
            f"{c.id} [{c.evidence_level}/{c.status}] {c.kind}: {c.statement[:110]}" for c in entries
        )

    def cmd_doctrine(self, _: str) -> str:
        return (
            "📜 Doctrina operațională\n"
            "1. Nicio cifră fără evidență — fiecare rezultat intră în registru cu nivelul său (simulated / operator_provided / confirmed).\n"
            "2. România e hub: toate prețurile se citesc ca basis față de RO; wheeling-ul trece prin RO.\n"
            "3. Limitele dau formă: MW pe graniță, concentrare ≤60%, REMIT screening — încălcarea e alertă, nu excepție.\n"
            "4. Suveranitate = opțiuni: măsurăm dependența de import și cine deține granița.\n"
            "5. Agentul propune, omul nominalizează. Nimic nu se execută din chat fără /nomineaza explicit.\n"
            "6. Falsifiabil: dacă basis-ul prezis nu se realizează, claim-ul rămâne provisional.\n"
            "Detalii: docs/SOVEREIGNTY_DOCTRINE.md — sau întreabă liber, caut în text."
        )

    # -- helpers --------------------------------------------------------
    def _brief(self, day: str, kind: str) -> dict | None:
        return self.store.load(f"briefs/{day}_{kind}")

    def _persist(self) -> None:
        self.store.save("book", [t.model_dump() for t in self.agent.book])
        self.store.save("claims", [c.model_dump() for c in self.agent.claims.entries])


def bot_commands_menu() -> list[dict[str, str]]:
    """Telegram ``setMyCommands`` payload so the menu shows what RONOR knows."""
    return [
        {"command": "azi", "description": "Ziua de azi într-un mesaj"},
        {"command": "maine", "description": "Ziua de mâine într-un mesaj"},
        {"command": "autorizez", "description": "Ce e de autorizat / autorizez"},
        {"command": "activeaza", "description": "Pornește agentul"},
        {"command": "dashboard", "description": "Link către ecran"},
        {"command": "ajutor", "description": "Cum vorbești cu mine"},
    ]
