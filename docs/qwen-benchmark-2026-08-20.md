# Qwen routing benchmark — 20 August 2026

Controlled Ollama checks used deterministic temperature, bounded output and
`keep_alive=0`. No repository content or secret was sent.

| Route | Location | Load | Generation | Total | Verdict |
|---|---|---:|---:|---:|---|
| `qwen3.5:4b` | laptop | 9.11 s | 11.38 tok/s | 10.18 s | PASS; interactive |
| `qwen3.5:35b-a3b` | Contabo | 28.78 s | 13.44 tok/s | 32.14 s | PASS; general batch |
| `qwen3-coder:30b` | Contabo | 25.57 s | 17.47 tok/s | 28.73 s | PASS; coding batch |

Operational policy:

- use Qwen 3.5 4B for low-latency private drafting and classification;
- use Qwen 3.5 35B-A3B for higher-quality sovereign analysis;
- use Qwen 3 Coder 30B for OpenHands and repository-scale coding;
- load large models on demand and unload after bounded work;
- keep paid cloud routes credential- and budget-gated;
- never interpret instant route selection as zero model cold-start latency.

OpenHands validation:

- the local OpenHands Agent Server is healthy and configured through its native
  settings for `openai/qwen3-coder:30b` via the private Ollama endpoint;
- the server can reach the OpenAI-compatible model endpoint;
- the isolated smoke conversation received no repository mount and emitted no
  tool action before it was stopped;
- this validates native OpenHands-to-Qwen connectivity only. RONOR's governed
  `/v1/execute` adapter contract remains fail-closed until a dedicated bridge is
  implemented and tested.
