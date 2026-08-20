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
    expect(js).toContain("ev.key==='Escape'");
    expect(js).toContain('nu are încă un adapter live conectat');
  });
});
