# RONOR Model Exchange v0.1 — Release Status

## Verification

- Production build: PASS
- End-to-end tests: 33/33 PASS
- Runtime dependency audit: 0 vulnerabilities
- Full npm audit after Vite upgrade: 0 vulnerabilities
- Verified with Node.js/npm in a clean install using `npm ci`

## Commands

```bash
npm ci
npm run check
npm audit
```

## Deployment prerequisites

- Set `OPENAI_API_KEY` as a secret environment variable.
- Do not commit `.env` files or API keys.
- Use `npm start` after `npm run build` (or use the supplied Render configuration).

## Prototype scope

- OpenAI GPT-4.1: live when an API key is configured.
- Anthropic Claude Sonnet 4: simulated adapter for demonstration only.
- Deterministic Core: live local execution.
- Ledgers are in-memory in v0.1 and reset on restart.
- R-Assurance performs structural checks and confidence calibration; it is not a universal factual-verification oracle.
