import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('CONTROL direct automation switchboard', () => {
  const script = readFileSync(join(process.cwd(), 'web/control/control.js'), 'utf8');

  it('connects LangGraph planning and OpenHands execution without a second UI approval', () => {
    expect(script).toContain("api('/automation/plan'");
    expect(script).toContain("api('/automation/run'");
    expect(script).toContain('approved: true');
    expect(script).toContain("target === 'langgraph'");
    expect(script).toContain("target === 'codex'");
    expect(script).not.toContain('nu are încă un adapter live conectat');
  });

  it('keeps Codex in the independent verifier role', () => {
    expect(script).toContain('autoritatea independentă de verificare');
    expect(script).toContain('nu acceptă instrucțiuni de implementare directă');
  });
});
