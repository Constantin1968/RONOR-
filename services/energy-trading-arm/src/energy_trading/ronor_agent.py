"""RONOR's brain with hands: an Ollama tool-calling loop over the energy module.

The model never sees a number it did not get from a tool.  Flow:

    operator text ─► model (system = doctrine, tools = capabilities)
                     ├─ tool_calls? ─► execute each via the operator bot ─► feed back
                     └─ final answer ─► operator

``Executor`` is anything that turns an operator command string into the bot's
reply — in-process (``/api/ronor`` uses the live bot) or over HTTP
(``HttpExecutor`` for the CLI / MCP server running elsewhere in the node).

Guardrails, in order of appearance:

* **route first** — if the deterministic Romanian intent matcher recognises
  the message ("cum stă ziua 13.09", "autorizez XB-0001", a pasted NTC table),
  the answer is the deterministic one and the model is not consulted at all.
  Small models skip tool calls or paraphrase content away; RONOR must not
  depend on their mood.  The model handles what routing cannot resolve.
* mutating tools (``autorizeaza`` above all) execute only when the operator's
  own message clearly asks for them, whatever the model decides;
* **grounding** — every number in the model's final reply must appear in some
  tool output, otherwise the operator gets the tool output verbatim;
* the loop is bounded; any Ollama failure degrades to the deterministic
  operator bot so RONOR never goes silent.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from typing import Any

from energy_trading.capabilities import BY_NAME, describe, openai_tools, to_command

log = logging.getLogger(__name__)

Executor = Callable[[str, str], str]  # (command_text, who) -> reply
Router = Callable[[str], str | None]  # operator text -> command, when unambiguous

NUM_RE = re.compile(r"\d+(?:[.,]\d+)?")


def numbers_grounded(reply: str, sources: list[str]) -> bool:
    """True when every number in ``reply`` occurs in one of ``sources``."""
    pool = set()
    for src in sources:
        for n in NUM_RE.findall(src):
            pool.add(n.replace(",", "."))
            pool.add(n.replace(",", "").replace(".", ""))
    for n in NUM_RE.findall(reply):
        if n.replace(",", ".") not in pool and n.replace(",", "").replace(".", "") not in pool:
            return False
    return True


SYSTEM = f"""Ești RONOR, nodul suveran de inteligență artificială. Vorbești cu operatorul uman al
operațiunilor de tranzacționare transfrontalieră a energiei electrice (RO/UA/MD, România ca hub
regional). Răspunzi în română, scurt, ca un coleg de birou care știe ce face.

Reguli absolute:
1. Orice cifră (preț, MW, MWh, euro, ore, capacitate) vine dintr-o unealtă. Nu inventezi și nu
   estimezi. Dacă nu ai apelat unealta, nu ai cifra.
2. Nu nominalizezi și nu recomanzi nominalizări din proprie inițiativă. Unealta `autorizeaza` se
   apelează doar când operatorul spune explicit că autorizează / confirmă / nominalizează.
3. Pentru 'cum stă ziua', 'ce facem azi', 'mâine' → apelezi întâi `ziua`. Pentru capacități →
   `capacitate`. Pentru 'ce am de confirmat' → `de_autorizat`.
4. Dacă operatorul lipește un tabel, prețuri pe intervale sau o decizie ('skip UA-MD') → `noteaza`
   cu textul exact.
5. Când o unealtă răspunde, redă-i conținutul fidel (poți scurta, nu poți schimba cifre) și adaugă
   cel mult o propoziție de context. Nu repeta întrebarea.
6. Dacă nu știi sau uneltele nu acoperă întrebarea, spui asta direct.

Unelte disponibile:
{describe()}
"""

MAX_ROUNDS = 4

# The human must have said it for a mutating tool to run, whatever the model thinks.
INTENT_GUARD: dict[str, re.Pattern[str]] = {
    "propuneri": re.compile(
        r"propun|ruleaz|calcul|azi|m[âa]ine|ziua|\d{1,2}[./]\d{1,2}", re.IGNORECASE
    ),
    "deconteaza": re.compile(r"decont|settle|[îi]nchide ziua|p&l realizat", re.IGNORECASE),
    "activeaza": re.compile(r"activ|porne|start|treze|drumul|lans", re.IGNORECASE),
    "opreste": re.compile(r"opre|dezactiv|stop|pauz", re.IGNORECASE),
    "noteaza": re.compile(r".", re.DOTALL),  # raw operator text is, by definition, the operator's
}
AUTH_VERB = re.compile(
    r"autoriz|confirm|nomin|aprob|semnez|\bok\b|\bda\b|\bhai\b|\bgo\b", re.IGNORECASE
)
AUTH_ALL = re.compile(r"\b(tot|toate|all|totul)\b", re.IGNORECASE)
QUESTION = re.compile(
    r"\?|\bce\b.*\b(trebuie|am|avem|e|este)\b|\bcare\b|\bc[âa]te?\b", re.IGNORECASE
)
XB_RE = re.compile(r"xb-\d+", re.IGNORECASE)


def guard_allows(tool_name: str, operator_text: str, args: dict[str, Any] | None = None) -> bool:
    """Mutations need the operator's own words behind them.

    ``autorizeaza`` is the strictest: the message must be an authorization, not a
    question about one, and it must name what it authorizes — every XB id the
    model wants to nominate must appear in the operator's text, or the operator
    must have said "tot/toate".
    """
    tool = BY_NAME.get(tool_name)
    if tool is None:
        return False
    if not tool.mutates:
        return True
    text = operator_text or ""
    if tool_name == "autorizeaza":
        if not AUTH_VERB.search(text) or QUESTION.search(text):
            return False
        wanted = {x.upper() for x in XB_RE.findall(str((args or {}).get("ids", "")))}
        said = {x.upper() for x in XB_RE.findall(text)}
        if wanted:
            return wanted <= said
        return bool(AUTH_ALL.search(text)) and bool(
            AUTH_ALL.search(str((args or {}).get("ids", "")))
        )
    pat = INTENT_GUARD.get(tool_name)
    return bool(pat and pat.search(text))


class HttpExecutor:
    """Run a command through a live module over HTTP (``POST /api/operator``).

    ``ask`` talks to the module's full brain instead (``/api/ronor``: routing,
    guards, model) — what a CLI or a remote dispatcher should use.
    """

    def __init__(self, api_url: str, token: str = "", timeout: float = 150.0):
        self.api_url = api_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _post(self, path: str, payload: dict) -> dict:
        from urllib.request import Request, urlopen

        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["X-RONOR-Token"] = self.token
        req = Request(f"{self.api_url}{path}", data=json.dumps(payload).encode(), headers=headers)
        with urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    def __call__(self, command: str, who: str) -> str:
        body = self._post("/api/operator", {"text": command, "who": who, "chat_id": "ronor"})
        return body.get("reply") or "(modulul nu a răspuns nimic)"

    def ask(self, text: str, who: str) -> dict:
        return self._post("/api/ronor", {"text": text, "who": who, "chat_id": "ronor"})


class RonorAgent:
    def __init__(
        self,
        execute: Executor,
        ollama_url: str,
        model: str,
        timeout: float = 120.0,
        post: Callable[[str, dict], dict] | None = None,
        fallback: Executor | None = None,
        route: Router | None = None,
    ):
        self.execute = execute
        self.route = route
        self.ollama_url = ollama_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self._post = post or self._http_post
        self.fallback = fallback or execute

    @property
    def enabled(self) -> bool:
        return bool(self.ollama_url and self.model)

    def _http_post(self, path: str, payload: dict) -> dict:
        from urllib.request import Request, urlopen

        req = Request(
            f"{self.ollama_url}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode())

    # -- one turn --------------------------------------------------------
    def run_tool(
        self,
        name: str,
        args: dict[str, Any] | None,
        operator_text: str,
        who: str,
    ) -> str:
        if name not in BY_NAME:
            return f"Unealtă necunoscută: {name}"
        if not guard_allows(name, operator_text, args):
            return (
                f"Refuzat: '{name}' modifică starea și operatorul nu a cerut asta explicit. "
                "Întreabă-l."
            )
        try:
            return self.execute(to_command(name, args), who)
        except Exception as exc:  # noqa: BLE001 — the model must hear the tool failed
            log.warning("tool %s failed: %s", name, exc)
            return f"Unealta {name} a eșuat: {exc}"

    def answer(self, text: str, who: str = "operator") -> dict:
        """Returns {'reply', 'tools': [names], 'mode': 'routed'|'ollama'|'fallback'}."""
        if not self.enabled:
            return {"reply": self.fallback(text, who), "tools": [], "mode": "fallback"}
        messages: list[dict] = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"[{who}] {text}"},
        ]
        used: list[str] = []
        outputs: list[str] = []

        routed = self.route(text) if self.route else None
        if routed:
            # Clear request → deterministic answer, already written for humans. The model
            # is not asked to paraphrase it: small models drop content, large ones add
            # latency, neither adds truth. The model is for what routing cannot resolve.
            try:
                result = self.execute(routed, who)
            except Exception as exc:  # noqa: BLE001 — surface, then fall back
                log.warning("routed command %s failed: %s", routed, exc)
                return {"reply": self.fallback(text, who), "tools": [], "mode": "fallback"}
            name = routed.split()[0].lstrip("/") if routed.startswith("/") else "noteaza"
            return {"reply": result, "tools": [name], "mode": "routed"}

        try:
            for _ in range(MAX_ROUNDS):
                out = self._post(
                    "/api/chat",
                    {
                        "model": self.model,
                        "stream": False,
                        "options": {"temperature": 0.1},
                        "tools": openai_tools(),
                        "messages": messages,
                    },
                )
                msg = out.get("message") or {}
                calls = msg.get("tool_calls") or []
                if not calls:
                    reply = (msg.get("content") or "").strip()
                    if not reply:
                        break
                    if outputs and not numbers_grounded(reply, outputs):
                        log.info("ungrounded numbers in model reply; returning tool output")
                        return {"reply": "\n\n".join(outputs), "tools": used, "mode": "routed"}
                    if not outputs and NUM_RE.search(reply):
                        # Numbers without any tool behind them: not RONOR's word.
                        log.info("numbers without tools; deterministic fallback")
                        break
                    return {"reply": reply, "tools": used, "mode": "ollama"}
                messages.append(msg)
                for call in calls:
                    fn = call.get("function") or {}
                    name = fn.get("name", "")
                    args = fn.get("arguments") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    used.append(name)
                    result = self.run_tool(name, args, text, who)
                    if not result.startswith(("Refuzat:", "Unealta ", "Unealtă ")):
                        outputs.append(result)
                    messages.append({"role": "tool", "tool_name": name, "content": result})
            # Out of rounds, silent or ungrounded model: hand the tool output straight over.
            if outputs:
                return {"reply": "\n\n".join(outputs), "tools": used, "mode": "routed"}
        except Exception as exc:  # noqa: BLE001 — never go silent
            log.warning("ollama agent failed (%s): deterministic fallback", exc)
            if outputs:
                return {"reply": "\n\n".join(outputs), "tools": used, "mode": "routed"}
        return {"reply": self.fallback(text, who), "tools": used, "mode": "fallback"}


def modelfile(base: str = "qwen2.5") -> str:
    """Ollama Modelfile that bakes the doctrine into RONOR's model as ``ronor-energy``."""
    system = SYSTEM.replace('"""', "'''")
    return (
        f'FROM {base}\nPARAMETER temperature 0.1\nPARAMETER num_ctx 8192\nSYSTEM """{system}"""\n'
    )


def create_model(
    ollama_url: str, base: str, name: str = "ronor-energy", timeout: float = 600.0
) -> dict:
    """``ollama create`` over the API (the Ollama binary lives on another node)."""
    from urllib.request import Request, urlopen

    payload = {
        "model": name,
        "from": base,
        "system": SYSTEM,
        "parameters": {"temperature": 0.1, "num_ctx": 8192},
        "stream": False,
    }
    req = Request(
        f"{ollama_url.rstrip('/')}/api/create",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode() or "{}")


def main(argv: list[str] | None = None) -> int:
    """CLI: ``python -m energy_trading.ronor_agent "cum stă ziua?"`` → the live module's brain."""
    import argparse
    import os

    p = argparse.ArgumentParser(description="RONOR energy agent (Ollama + tools)")
    p.add_argument("text", nargs="*")
    p.add_argument("--api", default=os.getenv("ET_API_URL", "http://localhost:8000"))
    p.add_argument("--token", default=os.getenv("ET_API_TOKEN", ""))
    p.add_argument("--ollama", default=os.getenv("OLLAMA_URL", "http://localhost:11434"))
    p.add_argument("--model", default=os.getenv("OLLAMA_MODEL", "ronor-energy"))
    p.add_argument("--who", default=os.getenv("USER", "operator"))
    p.add_argument("--modelfile", metavar="BASE", help="print the Modelfile for BASE and exit")
    p.add_argument(
        "--create-model", metavar="BASE", help="create 'ronor-energy' from BASE via Ollama API"
    )
    a = p.parse_args(argv)
    if a.modelfile:
        print(modelfile(a.modelfile), end="")
        return 0
    if a.create_model:
        out = create_model(a.ollama, a.create_model, a.model)
        print(f"model '{a.model}' din '{a.create_model}': {out.get('status', out)}")
        return 0
    if not a.text:
        p.error("text lipsă")
    out = HttpExecutor(a.api, a.token).ask(" ".join(a.text), a.who)
    print(out.get("reply", ""))
    print(f"\n[{out.get('mode')}: {', '.join(out.get('tools') or []) or '—'}]")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
