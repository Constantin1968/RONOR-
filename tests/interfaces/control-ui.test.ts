import fs from 'fs';
import path from 'path';

describe('CONTROL architect interface', () => {
  const root = path.resolve('web/control');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'control.js'), 'utf8');

  it('provides the four explicit architect views', () => {
    expect(html).toContain('CONTROL');
    expect(html).toContain('Switchboard');
    expect(html).toContain('Consiliu');
    expect(html).toContain('Misiuni');
    expect(html).toContain('SOVEREIGN MODEL CABINET');
    expect(html).toContain('MERLIN');
  });

  it('keeps credentials session-only and builds DOM without HTML injection', () => {
    expect(js).toContain('sessionStorage');
    expect(js).not.toContain('localStorage');
    expect(js).not.toContain('innerHTML');
    expect(js).toContain('textContent');
  });

  it('supports keyboard-first access and honest adapter status', () => {
    expect(js).toContain("ev.ctrlKey");
    expect(js).toContain("ev.key === 'Escape'");
    expect(js).toContain('nu are încă un adapter live conectat');
    expect(js).toContain("api('/models')");
  });

  it('renders live run stages, approvals, evidence, failures and bounded cancellation', () => {
    expect(html).toContain('runStages');
    expect(html).toContain('runApprovals');
    expect(html).toContain('runEvidence');
    expect(html).toContain('runFailures');
    expect(html).toContain('cancelRun');
    expect(js).toContain("api('/missions/'");
    expect(js).toContain("'/cancel'");
    expect(js).toContain('setTimeout');
    expect(js).toContain('stopPolling');
    expect(js).toContain('rollback automat');
  });
});
