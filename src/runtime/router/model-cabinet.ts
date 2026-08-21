import { ollamaBaseForModel } from '../providers/ollama';

export type ModelRouteStatus = 'available' | 'credential-gated' | 'install-required' | 'deferred';
export type BudgetClass = 0 | 1 | 2 | 3;
export type ModelModality = 'text' | 'code' | 'embedding' | 'vision' | 'audio' | 'image';

export interface ModelRoute {
  role: string;
  model: string;
  location: string;
  mode: 'interactive' | 'batch' | 'embedding' | 'cloud';
  status: ModelRouteStatus;
  rationale: string;
  modalities: ModelModality[];
  budget_class: BudgetClass;
  privacy: 'sovereign' | 'cloud';
  min_ram_gb?: number;
}

export interface ModelSelectionCriteria {
  modality: ModelModality;
  max_budget_class: BudgetClass;
  require_sovereign?: boolean;
  require_interactive?: boolean;
}

function installedModels(env: NodeJS.ProcessEnv): Set<string> {
  const declared = (env.RONOR_INSTALLED_MODELS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return new Set([
    'qwen3:4b-instruct', 'qwen3.5:4b', 'qwen2.5-coder:3b', 'qwen2.5:72b-instruct-q4_K_M',
    'qwen3.5:35b-a3b', 'qwen3-coder:30b',
    'deepseek-r1:70b-llama-distill-q4_K_M', 'llama3.1:70b-instruct-q4_K_M', 'bge-m3:latest',
    ...declared,
  ]);
}

export function modelCabinet(env: NodeJS.ProcessEnv): ModelRoute[] {
  const local = env.OLLAMA_ENABLED === 'true';
  const contabo = local && ollamaBaseForModel('qwen2.5:72b-instruct-q4_K_M', env) !== null;
  const installed = installedModels(env);
  const localStatus = (model: string): ModelRouteStatus => local && installed.has(model) ? 'available' : 'install-required';
  const contaboStatus = (model: string): ModelRouteStatus => contabo && installed.has(model) ? 'available' : 'install-required';
  const qwenCloud: ModelRouteStatus = env.DASHSCOPE_API_KEY ? 'available' : 'credential-gated';

  return [
    { role: 'rapid-private', model: 'qwen3:4b-instruct', location: 'laptop', mode: 'interactive', status: localStatus('qwen3:4b-instruct'), rationale: 'Low latency, private drafting and analysis.', modalities: ['text'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 4 },
    { role: 'qwen-laptop-upgrade', model: 'qwen3.5:4b', location: 'laptop', mode: 'interactive', status: localStatus('qwen3.5:4b'), rationale: 'Multimodal interactive Qwen upgrade.', modalities: ['text', 'vision'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 5 },
    { role: 'coding-local', model: 'qwen2.5-coder:3b', location: 'laptop', mode: 'interactive', status: localStatus('qwen2.5-coder:3b'), rationale: 'Bounded code assistance before independent verification.', modalities: ['code'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 4 },
    { role: 'memory', model: 'bge-m3:latest', location: 'contabo', mode: 'embedding', status: contaboStatus('bge-m3:latest'), rationale: '1024-dimensional sovereign semantic memory.', modalities: ['embedding'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 3 },
    { role: 'analysis-baseline', model: 'qwen2.5:72b-instruct-q4_K_M', location: 'contabo', mode: 'batch', status: contaboStatus('qwen2.5:72b-instruct-q4_K_M'), rationale: 'Current sovereign high-quality batch baseline.', modalities: ['text'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 48 },
    { role: 'qwen-moe-primary', model: 'qwen3.5:35b-a3b', location: 'contabo', mode: 'batch', status: contaboStatus('qwen3.5:35b-a3b'), rationale: 'Efficient multimodal MoE primary after benchmark promotion.', modalities: ['text', 'code', 'vision'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 30 },
    { role: 'qwen-dense-candidate', model: 'qwen3.5:27b', location: 'contabo-candidate', mode: 'batch', status: contaboStatus('qwen3.5:27b'), rationale: 'Dense quality comparison candidate.', modalities: ['text', 'code', 'vision'], budget_class: 1, privacy: 'sovereign', min_ram_gb: 24 },
    { role: 'qwen-agentic-code-local', model: 'qwen3-coder:30b', location: 'contabo-candidate', mode: 'batch', status: contaboStatus('qwen3-coder:30b'), rationale: 'Agentic coding with 256K repository context.', modalities: ['code'], budget_class: 1, privacy: 'sovereign', min_ram_gb: 24 },
    { role: 'qwen-frontier', model: 'qwen3.8-max', location: 'alibaba-cloud', mode: 'cloud', status: qwenCloud, rationale: 'Flagship Qwen escalation for maximum quality and million-token context.', modalities: ['text', 'code', 'vision'], budget_class: 3, privacy: 'cloud' },
    { role: 'qwen-agentic-code-cloud', model: 'qwen3-coder-next / qwen3-coder-plus', location: 'alibaba-cloud', mode: 'cloud', status: qwenCloud, rationale: 'Specialised cloud coding route.', modalities: ['code'], budget_class: 2, privacy: 'cloud' },
    { role: 'qwen-speech', model: 'Qwen3-ASR', location: 'self-hosted-candidate', mode: 'interactive', status: installed.has('Qwen3-ASR') ? 'available' : 'install-required', rationale: 'Private speech-to-text for CONTROL.', modalities: ['audio'], budget_class: 1, privacy: 'sovereign', min_ram_gb: 4 },
    { role: 'qwen-omni', model: 'qwen3.5-omni-plus', location: 'alibaba-cloud', mode: 'cloud', status: qwenCloud, rationale: 'Realtime text, audio, image and video interaction.', modalities: ['text', 'vision', 'audio'], budget_class: 2, privacy: 'cloud' },
    { role: 'qwen-image', model: 'qwen-image-3.0-pro', location: 'alibaba-cloud', mode: 'cloud', status: qwenCloud, rationale: 'Multilingual image generation and editing.', modalities: ['image'], budget_class: 2, privacy: 'cloud' },
    { role: 'local-verification', model: 'llama3.1:70b-instruct-q4_K_M', location: 'contabo', mode: 'batch', status: contaboStatus('llama3.1:70b-instruct-q4_K_M'), rationale: 'Independent local review using a different model family.', modalities: ['text'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 48 },
    { role: 'deep-reasoning', model: 'deepseek-r1:70b-llama-distill-q4_K_M', location: 'contabo', mode: 'batch', status: contaboStatus('deepseek-r1:70b-llama-distill-q4_K_M'), rationale: 'Asynchronous reasoning with a larger output budget.', modalities: ['text'], budget_class: 0, privacy: 'sovereign', min_ram_gb: 48 },
    { role: 'frontier-escalation', model: 'Codex / Claude / Kimi / Grok 4.5', location: 'cloud', mode: 'cloud', status: 'credential-gated', rationale: 'Human-authorised frontier escalation.', modalities: ['text', 'code'], budget_class: 3, privacy: 'cloud' },
    { role: 'multimodal-agentic', model: 'Gemini 3.7 Flash / Gemini 3.1 Pro', location: 'cloud', mode: 'cloud', status: env.GEMINI_API_KEY ? 'available' : 'credential-gated', rationale: 'Agentic coding, multimodal analysis and large-context work.', modalities: ['text', 'code', 'vision'], budget_class: 2, privacy: 'cloud' },
    { role: 'managed-executor', model: 'Manus API v2', location: 'cloud', mode: 'cloud', status: 'deferred', rationale: 'Deferred until after the 23–25 August review window.', modalities: ['text', 'code'], budget_class: 2, privacy: 'cloud' },
  ];
}

export function selectModelRoutes(routes: ModelRoute[], criteria: ModelSelectionCriteria): ModelRoute[] {
  return routes
    .filter((route) => route.status === 'available')
    .filter((route) => route.modalities.includes(criteria.modality))
    .filter((route) => route.budget_class <= criteria.max_budget_class)
    .filter((route) => !criteria.require_sovereign || route.privacy === 'sovereign')
    .filter((route) => !criteria.require_interactive || route.mode === 'interactive')
    .sort((a, b) => a.budget_class - b.budget_class || a.role.localeCompare(b.role));
}
