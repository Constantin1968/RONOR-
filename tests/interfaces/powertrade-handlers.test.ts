import {
  cmdMetrici,
  cmdPropunere,
  decidePropunere,
  parsePropunereArgs,
} from '../../src/interfaces/telegram/energy-trading/handlers';
import { authoriseTradingCommand, tradingBucketFor } from '../../src/interfaces/telegram/energy-trading/roles';
import { TradingApiError } from '../../src/interfaces/telegram/energy-trading/trading-client';
import type { TradingClient } from '../../src/interfaces/telegram/energy-trading/trading-client';

function ctxWith(client: Partial<TradingClient>) {
  return {
    userId: 1,
    userName: 'Test',
    assignment: { namespace: 'nrgpaths' as const, role: 'trading_trainer' as const },
    client: client as TradingClient,
  };
}

describe('R-PowerTrade în bot', () => {
  it('încadrează comenzile noi în roluri', () => {
    expect(tradingBucketFor('propunere')).toBe('initiate');
    expect(tradingBucketFor('metrici')).toBe('read');
    expect(authoriseTradingCommand('initiate', { namespace: 'encon', role: 'trading_observer' }).allowed).toBe(false);
    expect(authoriseTradingCommand('initiate', { namespace: 'nrgpaths', role: 'trading_trainer' }).allowed).toBe(true);
  });

  it('refuză propunerea fără JSON valid, fără zi sau fără ore', () => {
    expect(typeof parsePropunereArgs('')).toBe('string');
    expect(typeof parsePropunereArgs('20 MW pe h2')).toBe('string');
    expect(typeof parsePropunereArgs('{"day":"02.10","hours":[{}]}')).toBe('string');
    expect(typeof parsePropunereArgs('{"day":"2026-10-02","hours":[]}')).toBe('string');
    const ok = parsePropunereArgs('{"day":"2026-10-02","hours":[{"hour":2,"route":"UA-MD","nominate_mw":"10","prices":{}}]}');
    expect(typeof ok).not.toBe('string');
  });

  it('afișează propunerea cu răspunsul implicit NU și semnalează orele eligibile', async () => {
    const powertradePropose = jest.fn().mockResolvedValue({
      kind: 'proposal', stage: 'shadow', default_decision: 'nu', proposal_seq: 7,
      hours: [
        { hour: 2, route: 'UA-MD', nominate_mw: '20', eligible: false, reasons: ['h2: 20 MW peste plafonul de criză 10 MW'] },
        { hour: 3, route: 'UA-MD', nominate_mw: '10', eligible: true, reasons: [] },
      ],
    });
    const r = await cmdPropunere(ctxWith({ powertradePropose }),
      '{"day":"2026-10-02","hours":[{"hour":2,"route":"UA-MD","nominate_mw":"20","prices":{}}]}');
    expect(powertradePropose).toHaveBeenCalledTimes(1);
    expect(r.proposalSeq).toBe(7);
    expect(r.anyEligible).toBe(true);
    expect(r.text).toContain('NU');
    expect(r.text).toContain('plafonul de criză');
  });

  it('în Shadow, Da/Nu nu se înregistrează și nu nominalizează', async () => {
    const powertradeDecide = jest.fn().mockRejectedValue(new TradingApiError(403, 'shadow', 'forbidden'));
    const text = await decidePropunere({ powertradeDecide } as unknown as TradingClient,
      '2026-10-02', 7, 'da', 'Suveran', 'telegram:1:cb');
    expect(text).toContain('Etapa Shadow');
  });

  it('în Gated, un Da trimite referința aprobării și nu execută', async () => {
    const powertradeDecide = jest.fn().mockResolvedValue({ recorded: true, decision: 'da', ledger_seq: 9, executes: false });
    const text = await decidePropunere({ powertradeDecide } as unknown as TradingClient,
      '2026-10-02', 7, 'da', 'Suveran', 'telegram:1:cb');
    expect(powertradeDecide).toHaveBeenCalledWith(
      { day: '2026-10-02', proposal_seq: 7, decision: 'da', approval_ref: 'telegram:1:cb' }, 'Suveran');
    expect(text).toContain('Nu s-a nominalizat nimic');
  });

  it('metricile neevaluate nu trec poarta Gated', async () => {
    const powertradeMetrics = jest.fn().mockResolvedValue({
      stage: 'shadow', metrics: { evaluated: false, days: 0, reason: 'istoric insuficient: 0 din 20 zile' },
      gated_gate: { pass: false },
    });
    const text = await cmdMetrici(ctxWith({ powertradeMetrics }));
    expect(text).toContain('nu trece');
  });
});
