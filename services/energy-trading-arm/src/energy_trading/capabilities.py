"""What RONOR can *do* with the energy module — one registry, three surfaces.

Every capability is a named tool with a JSON schema and a mapping to one of the
operator commands.  The same list feeds:

* Ollama tool calling (``openai_tools``) — RONOR's own model gets hands;
* the MCP server (``mcp_tools``) — any other agent in the RONOR node;
* ``ronor/tools.json`` — a static copy for dispatchers that hard-code routing.

Keeping it in one place means the model, the MCP client and the docs can never
disagree about what the module does.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

DAY = {
    "type": "string",
    "description": "Ziua: 'azi', 'maine' sau o dată ca '14.09' / '2026-09-14'. Implicit azi.",
}


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    command: str
    params: dict[str, dict[str, Any]] = field(default_factory=dict)
    required: tuple[str, ...] = ()
    mutates: bool = False  # changes the book / scheduler → the human must have asked for it

    @property
    def schema(self) -> dict:
        return {
            "type": "object",
            "properties": dict(self.params),
            "required": list(self.required),
        }

    def to_command(self, args: dict[str, Any] | None) -> str:
        args = {k: v for k, v in (args or {}).items() if v not in (None, "")}
        text = self.command.format(**{k: args.get(k, "") for k in self.params}).strip()
        return " ".join(text.split())


TOOLS: tuple[Tool, ...] = (
    Tool(
        "ziua",
        "Ziua de tranzacționare într-un mesaj: prețuri (reale/simulate), NTC, ce e închis, "
        "ce e subțire, ce propune agentul și ce trebuie confirmat. Prima unealtă de apelat "
        "pentru 'cum stă ziua', 'ce facem azi/mâine'.",
        "/azi {day}",
        {"day": DAY},
    ),
    Tool(
        "capacitate",
        "Capacitățile transfrontaliere (NTC/ATC) pe ore pentru RO-UA, UA-RO, UA-MD, MD-UA, "
        "RO-MD, MD-RO: medie, minim, ferestre utile, ce e închis.",
        "/ntc {day}",
        {"day": DAY},
    ),
    Tool(
        "hub",
        "România ca hub regional: basis-ul (diferența de preț) față de piețele vecine "
        "(HU, BG, RS, MD, UA), oportunități de wheeling și arbitraj.",
        "/hub {day}",
        {"day": DAY},
    ),
    Tool(
        "meteo",
        "Prognoza meteo și semnalele de cerere/eolian/solar pentru RO, BG, RS, HU, MD, UA.",
        "/meteo",
    ),
    Tool(
        "granite",
        "Lista interconectorilor acoperiți, cu TSO, capacitate tehnică, tarife și pierderi.",
        "/granite",
    ),
    Tool(
        "propuneri",
        "Rulează agentul pe o zi: caută spread-uri nete pozitive, aplică limitele de risc și "
        "REMIT și pune propunerile în book cu status 'proposed'. Nu nominalizează nimic.",
        "/propuneri {day}",
        {"day": DAY},
        mutates=True,
    ),
    Tool(
        "de_autorizat",
        "Ce așteaptă confirmarea omului: propunerile 'proposed' grupate pe direcție, cu MWh și "
        "P&L așteptat și ID-urile XB-....",
        "/autorizez",
    ),
    Tool(
        "autorizeaza",
        "Nominalizează propuneri — DOAR când operatorul uman a spus explicit că autorizează. "
        "ids: 'tot' sau ID-uri 'XB-0001 XB-0002'. Se înregistrează cine a autorizat.",
        "/autorizez {ids}",
        {
            "ids": {
                "type": "string",
                "description": "'tot' sau lista de ID-uri XB-.... separate prin spațiu",
            }
        },
        required=("ids",),
        mutates=True,
    ),
    Tool(
        "book",
        "Portofoliul curent: tranzacții pe status (proposed / nominated / settled), volume, P&L.",
        "/book",
    ),
    Tool(
        "deconteaza",
        "Decontează tranzacțiile nominalizate cu livrare trecută și calculează P&L realizat.",
        "/deconteaza",
        mutates=True,
    ),
    Tool(
        "pl",
        "Raportul P/L Digital Twin pentru o zi livrată (implicit ieri): ce a câștigat real "
        "poziția operatorului la prețurile publicate (OPCOM RO, OREE UA), ce ar fi făcut "
        "twin-ul, idealul cu hindsight, CBC plătit, ore ratate, cumulat pe lună. "
        "Pentru 'cât am făcut ieri', 'P/L pe 13.09', 'rezultatul zilei'.",
        "/pl {day}",
        {"day": DAY},
    ),
    Tool(
        "preturi",
        "Citește acum prețurile publicate (OPCOM pentru RO, OREE + curs NBU pentru UA) pentru "
        "azi și mâine, sau pentru o zi dată, și le pune în fișierele zilei. Sursele sunt "
        "citite oricum periodic; util când operatorul întreabă 'a ieșit OPCOM?'.",
        "/preturi {day}",
        {"day": DAY},
    ),
    Tool(
        "status",
        "Starea modulului: veghe 24/7 activă/oprită, ce urmează, ce veghează, reîncercări, "
        "ultimele job-uri, book, mod Ollama.",
        "/status",
    ),
    Tool(
        "alerte",
        "Ultimele alerte: concentrare pe o graniță, basis larg, CBC subțire, erori de workeri.",
        "/alerte {n}",
        {"n": {"type": "integer", "description": "Câte alerte (implicit 5)"}},
    ),
    Tool(
        "suveranitate",
        "Raportul doctrinei: dependență de import, bilanț energie/carbon, expunere pe zone.",
        "/suveranitate",
    ),
    Tool(
        "registru",
        "Registrul afirmațiilor (claims): fiecare rulare, nominalizare și decontare, cu nivel de "
        "evidență și cine a autorizat.",
        "/claims {n}",
        {"n": {"type": "integer", "description": "Câte intrări (implicit 5)"}},
    ),
    Tool(
        "doctrina",
        "Principiile doctrinei de suveranitate energetică pe care le urmează modulul.",
        "/doctrina",
    ),
    Tool(
        "intreaba",
        "Caută în documentația și doctrina modulului (README, doctrina de suveranitate) și "
        "răspunde ancorat în text. Pentru întrebări conceptuale: ce e basis-ul, cum funcționează "
        "cuplarea piețelor, ce e REMIT, ce reguli urmează agentul.",
        "/intreaba {intrebare}",
        {"intrebare": {"type": "string", "description": "Întrebarea, în cuvintele operatorului"}},
        required=("intrebare",),
    ),
    Tool(
        "activeaza",
        "Pornește veghea 24/7: meteo 06:00, ziua 09:00, recap 18:00, plus date noi → ziua "
        "refăcută în ≤1 min, decontare orară, memento înainte de gate, reîncercări.",
        "/activeaza",
        mutates=True,
    ),
    Tool(
        "opreste",
        "Oprește veghea 24/7. Nimic nu mai rulează automat până la 'activeaza'.",
        "/opreste",
        mutates=True,
    ),
    Tool(
        "noteaza",
        "Trimite modulului o notă operațională brută: tabel NTC lipit ca text, prețuri pe "
        "intervale, decizii ('skip UA-MD'). Modulul o parsează și o aplică zilei.",
        "{text}",
        {"text": {"type": "string", "description": "Nota exact așa cum a scris-o operatorul"}},
        required=("text",),
        mutates=True,
    ),
)

BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}


def to_command(name: str, args: dict[str, Any] | None = None) -> str:
    """Tool call → the operator command the bot already understands."""
    tool = BY_NAME.get(name)
    if tool is None:
        raise KeyError(name)
    return tool.to_command(args)


def openai_tools() -> list[dict]:
    """Ollama / OpenAI ``tools=`` payload."""
    return [
        {
            "type": "function",
            "function": {"name": t.name, "description": t.description, "parameters": t.schema},
        }
        for t in TOOLS
    ]


def mcp_tools() -> list[dict]:
    """MCP ``tools/list`` payload."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "inputSchema": t.schema,
            "annotations": {"readOnlyHint": not t.mutates, "destructiveHint": False},
        }
        for t in TOOLS
    ]


def describe() -> str:
    """Plain-text capability sheet, used in the Modelfile and CAPABILITY.md."""
    lines = []
    for t in TOOLS:
        args = ", ".join(f"{k}{'*' if k in t.required else ''}" for k in t.params) or "—"
        lines.append(f"- {t.name}({args}): {t.description}")
    return "\n".join(lines)


if __name__ == "__main__":  # python -m energy_trading.capabilities > ronor/tools.json
    print(json.dumps({"openai": openai_tools(), "mcp": mcp_tools()}, ensure_ascii=False, indent=2))
