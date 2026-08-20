import { ollamaBaseForModel } from '../providers/ollama';

export interface ModelRoute { role: string; model: string; location: string; mode: 'interactive' | 'batch' | 'embedding' | 'cloud'; status: 'available' | 'credential-gated'; rationale: string; }

export function modelCabinet(env: NodeJS.ProcessEnv): ModelRoute[] {
  const local = env.OLLAMA_ENABLED === 'true';
  const contabo = local && ollamaBaseForModel('qwen2.5:72b-instruct-q4_K_M', env) !== null;
  return [
    { role: 'rapid-private', model: 'qwen3:4b-instruct', location: 'laptop', mode: 'interactive', status: local ? 'available' : 'credential-gated', rationale: 'Low latency, private drafting and analysis.' },
    { role: 'coding-local', model: 'qwen2.5-coder:3b', location: 'laptop', mode: 'interactive', status: local ? 'available' : 'credential-gated', rationale: 'Bounded code assistance before independent verification.' },
    { role: 'memory', model: 'bge-m3:latest', location: 'contabo', mode: 'embedding', status: contabo ? 'available' : 'credential-gated', rationale: '1024-dimensional sovereign semantic memory.' },
    { role: 'analysis-batch', model: 'qwen2.5:72b-instruct-q4_K_M', location: 'contabo', mode: 'batch', status: contabo ? 'available' : 'credential-gated', rationale: 'Primary sovereign high-quality batch analysis.' },
    { role: 'local-verification', model: 'llama3.1:70b-instruct-q4_K_M', location: 'contabo', mode: 'batch', status: contabo ? 'available' : 'credential-gated', rationale: 'Independent local review using a different model family.' },
    { role: 'deep-reasoning', model: 'deepseek-r1:70b-llama-distill-q4_K_M', location: 'contabo', mode: 'batch', status: contabo ? 'available' : 'credential-gated', rationale: 'Asynchronous reasoning with a larger output budget.' },
    { role: 'frontier-escalation', model: 'Codex / Claude / Kimi', location: 'cloud', mode: 'cloud', status: 'credential-gated', rationale: 'Human-authorised escalation for frontier quality or independent evidence.' },
  ];
}
