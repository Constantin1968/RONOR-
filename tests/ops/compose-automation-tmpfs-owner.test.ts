/**
 * The OpenHands agent runs as 10001 with every capability dropped. Its
 * conversations directory is a tmpfs recreated at each container start, so it
 * must be mounted already owned by that user or the agent cannot start a
 * conversation after a restart (run_4540ee2000c3bb9de91a, 2 October 2026).
 */
import { readFileSync } from 'fs';
import path from 'path';

const compose = readFileSync(path.join(__dirname, '..', '..', 'docker-compose.automation.yml'), 'utf8');

describe('docker-compose.automation.yml OpenHands tmpfs ownership', () => {
  it('mounts /workspace/conversations owned by the agent user', () => {
    const line = compose.split('\n').find((l) => l.includes('/workspace/conversations:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/uid=10001/);
    expect(line).toMatch(/gid=10001/);
    expect(line).toMatch(/mode=0700/);
  });
});
