/** RONOR CONTROL · Ma11AI Executive Intelligence Council. */

export type ManagementDomain =
  | 'executive' | 'strategy' | 'operations' | 'technology' | 'governance'
  | 'security' | 'finance' | 'legal' | 'privacy' | 'product' | 'people'
  | 'commercial' | 'assurance' | 'risk' | 'intelligence' | 'research'
  | 'architecture' | 'compliance' | 'transformation' | 'sustainability'
  | 'markets' | 'communications' | 'infrastructure' | 'customer' | 'knowledge';

export interface ManagementAgent {
  agent_id: string;
  name: string;
  role: string;
  email: string;
  functional_email: string;
  domain: ManagementDomain;
  reports_to: 'merlin' | 'richard';
  mandate: string;
  statutory_authority: false;
  external_send_authority: false;
  email_status: 'proposed';
}

const agent = (
  agent_id: string, name: string, role: string, domain: ManagementDomain,
  functional: string, mandate: string, reports_to: 'merlin' | 'richard' = 'richard',
): ManagementAgent => Object.freeze({
  agent_id, name, role, domain, mandate, reports_to,
  email: `${agent_id}@ma11ai.com`, functional_email: `${functional}@ma11ai.com`,
  statutory_authority: false, external_send_authority: false,
  email_status: 'proposed',
});

const COUNCIL: readonly ManagementAgent[] = Object.freeze([
  agent('richard', 'Richard Fairchild', 'AI Chief Executive Adviser', 'executive', 'executive', 'Translate Merlin\'s objectives into governed, attributable execution.', 'merlin'),
  agent('arthur', 'Arthur Whitmore', 'AI Chief Strategy Adviser', 'strategy', 'strategy', 'Own strategy, priorities and scenarios.'),
  agent('eleanor', 'Eleanor Hartley', 'AI Chief Operating Adviser', 'operations', 'operations', 'Coordinate delivery, dependencies and operating performance.'),
  agent('james', 'James Ashcroft', 'AI Chief Technology Adviser', 'technology', 'technology', 'Own technology feasibility and engineering direction.'),
  agent('charlotte', 'Charlotte Pembroke', 'AI Chief Governance Adviser', 'governance', 'governance', 'Maintain corporate governance and decision records.'),
  agent('oliver', 'Oliver Wren', 'AI Chief Security & Resilience Adviser', 'security', 'security', 'Assess security, resilience and incident controls.'),
  agent('amelia', 'Amelia Sterling', 'AI Chief Finance & Value Adviser', 'finance', 'finance', 'Assess budgets, value, cost and financial exposure.'),
  agent('henry', 'Henry Blackwood', 'AI Chief Legal & Regulatory Adviser', 'legal', 'legal-intake', 'Identify legal obligations and escalate for qualified human advice.'),
  agent('sophie', 'Sophie Langford', 'AI Chief Data, Privacy & AI Governance Adviser', 'privacy', 'privacy', 'Govern data, privacy and responsible AI controls.'),
  agent('edward', 'Edward Hawthorne', 'AI Chief Product Adviser', 'product', 'product', 'Own product outcomes and portfolio coherence.'),
  agent('isabelle', 'Isabelle Fairfax', 'AI Chief People & Organisation Adviser', 'people', 'people', 'Advise on organisation, capacity and conduct.'),
  agent('thomas', 'Thomas Redgrave', 'AI Chief Commercial & Partnerships Adviser', 'commercial', 'commercial', 'Assess commercial strategy, partnerships and customers.'),
  agent('victoria', 'Victoria Ellison', 'AI Chief Independent Assurance Adviser', 'assurance', 'assurance', 'Independently verify outcomes and report directly to Merlin.', 'merlin'),
  agent('william', 'William Ravenscroft', 'AI Chief Risk Adviser', 'risk', 'risk', 'Own enterprise risk aggregation and escalation.', 'merlin'),
  agent('alexander', 'Alexander Hargreaves', 'AI Chief Intelligence Adviser', 'intelligence', 'intelligence', 'Fuse strategic, competitive and geopolitical intelligence.'),
  agent('beatrice', 'Beatrice Kingsley', 'AI Chief Research & Development Adviser', 'research', 'research', 'Govern experiments, research evidence and technology readiness.'),
  agent('frederick', 'Frederick Beaumont', 'AI Chief Architecture Adviser', 'architecture', 'architecture', 'Protect canonical architecture and technical coherence.'),
  agent('catherine', 'Catherine Winslow', 'AI Chief Compliance Adviser', 'compliance', 'compliance', 'Maintain the obligations register and compliance evidence.', 'merlin'),
  agent('george', 'George Montfort', 'AI Chief Transformation Adviser', 'transformation', 'transformation', 'Coordinate organisational and digital transformation.'),
  agent('elizabeth', 'Elizabeth Carrington', 'AI Chief Sustainability & Impact Adviser', 'sustainability', 'sustainability', 'Assess environmental and social impact.'),
  agent('sebastian', 'Sebastian Northcott', 'AI Chief Markets Adviser', 'markets', 'markets', 'Coordinate energy, capital-markets and Web3 intelligence.'),
  agent('margaret', 'Margaret Sinclair', 'AI Chief Communications & Reputation Adviser', 'communications', 'communications', 'Protect truthful communications and reputation.'),
  agent('christopher', 'Christopher Aldridge', 'AI Chief Infrastructure & Reliability Adviser', 'infrastructure', 'infrastructure', 'Own platform reliability and infrastructure readiness.'),
  agent('penelope', 'Penelope Westbrook', 'AI Chief Customer & Ecosystem Adviser', 'customer', 'customer', 'Represent customer and ecosystem outcomes.'),
  agent('jonathan', 'Jonathan Lockwood', 'AI Chief Knowledge & Memory Adviser', 'knowledge', 'knowledge', 'Govern institutional memory, provenance and retrieval.'),
]);

function clone(a: ManagementAgent): ManagementAgent { return { ...a }; }
export function managementAgents(): ManagementAgent[] { return COUNCIL.map(clone); }
export function getManagementAgent(id: string): ManagementAgent | null {
  const found = COUNCIL.find((a) => a.agent_id === id.toLowerCase());
  return found ? clone(found) : null;
}
