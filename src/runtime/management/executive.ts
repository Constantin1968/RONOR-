import { appendMissionFabricEvent, createMission } from '../mission/store';
import { getManagementAgent, managementAgents, type ManagementDomain } from './registry';

export interface ExecutiveDelegation {
  mission_id: string;
  objective: string;
  accountable: string;
  responsible: string[];
  consulted: string[];
  informed: string[];
  independent_verifier: string;
  requires_merlin_approval: string[];
  communication: {
    status: 'draft';
    from: string;
    to: string[];
    cc: string[];
    subject: string;
    disclaimer: string;
  };
}

const RULES: Array<{ domain: ManagementDomain; pattern: RegExp; agents: string[] }> = [
  { domain: 'security', pattern: /security|securitate|cyber|incident|breach|vulnerab|attack|atac/i, agents: ['oliver', 'christopher'] },
  { domain: 'technology', pattern: /code|cod|software|technical|tehnic|api|agent|model|platform|runtime|performance|performan/i, agents: ['james', 'frederick'] },
  { domain: 'infrastructure', pattern: /server|cloud|deploy|infrastructur|network|retea|rețea|database|baza de date|reliability|fiabilitate/i, agents: ['christopher', 'james'] },
  { domain: 'research', pattern: /research|cercetare|experiment|prototype|prototip|innovation|inovare|r&d/i, agents: ['beatrice', 'alexander'] },
  { domain: 'markets', pattern: /energy|capital market|trading|web3|blockchain|token/i, agents: ['sebastian', 'amelia'] },
  { domain: 'privacy', pattern: /personal data|date personale|privacy|confidentialitate|gdpr|data protection|protectia datelor|protecția datelor/i, agents: ['sophie', 'catherine'] },
  { domain: 'legal', pattern: /legal|juridic|contract|regulation|reglement|licen[cs]e|licență|law|lege/i, agents: ['henry', 'catherine'] },
  { domain: 'commercial', pattern: /customer|sales|partner|commercial|pricing/i, agents: ['thomas', 'penelope'] },
  { domain: 'product', pattern: /product|launch|feature|roadmap|user/i, agents: ['edward', 'eleanor'] },
  { domain: 'communications', pattern: /public|press|email|communication|reputation/i, agents: ['margaret', 'charlotte'] },
  { domain: 'knowledge', pattern: /memory|knowledge|cida|continuumpedia|evidence/i, agents: ['jonathan', 'alexander'] },
];

export function planExecutiveDelegation(params: {
  objective: string;
  operatorId?: string | null;
}): ExecutiveDelegation {
  const objective = params.objective.trim();
  if (!objective || objective.length > 8000) throw new Error('A bounded objective is required.');
  const mission = createMission({
    title: objective.slice(0, 120), objective, operatorId: params.operatorId ?? 'merlin',
  });
  const selected = new Set<string>();
  for (const rule of RULES) if (rule.pattern.test(objective)) rule.agents.forEach((id) => selected.add(id));
  if (selected.size === 0) ['arthur', 'eleanor', 'edward'].forEach((id) => selected.add(id));

  // Risk and independent assurance are never optional; they are deliberately
  // outside the execution chain so the implementing agent cannot approve itself.
  const responsible = [...selected];
  const consulted = ['william', 'catherine', 'oliver'].filter((id) => !selected.has(id));
  const informed = ['merlin'];
  const participants = [...new Set([...responsible, ...consulted, 'victoria'])];
  let version = 0;
  for (const id of participants) {
    const member = getManagementAgent(id)!;
    appendMissionFabricEvent({
      missionId: mission.mission_id, expectedVersion: version++,
      actor: { kind: 'ronor', id: 'richard' }, type: 'task.upserted',
      payload: {
        id: `executive-${id}`, assignee: id, role: member.role,
        status: id === 'victoria' ? 'awaiting-independent-verification' : 'assigned',
        objective,
      },
    });
  }
  appendMissionFabricEvent({
    missionId: mission.mission_id, expectedVersion: version,
    actor: { kind: 'ronor', id: 'richard' }, type: 'approval.required',
    payload: {
      id: 'merlin-consequential-action', approver: 'merlin', status: 'not-required-until-consequential-action',
      triggers: ['external-send', 'contract', 'financial-commitment', 'merge', 'release', 'deployment', 'destructive-action'],
    },
  });

  const lookup = new Map(managementAgents().map((a) => [a.agent_id, a]));
  return {
    mission_id: mission.mission_id, objective, accountable: 'richard', responsible, consulted,
    informed, independent_verifier: 'victoria',
    requires_merlin_approval: ['external-send', 'contract', 'financial-commitment', 'merge', 'release', 'deployment', 'destructive-action'],
    communication: {
      status: 'draft', from: lookup.get('richard')!.email,
      to: responsible.map((id) => lookup.get(id)!.email),
      cc: consulted.map((id) => lookup.get(id)!.email).concat(lookup.get('victoria')!.email),
      subject: `[MISSION ${mission.mission_id}] ${objective.slice(0, 100)}`,
      disclaimer: 'Prepared by an identified Ma11AI AI agent. Not a statutory-director signature or binding commitment without authorised human approval.',
    },
  };
}
