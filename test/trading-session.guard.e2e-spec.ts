import { evaluateTradingSessionGuard } from '../src/common/utils/trading-session';

describe('evaluateTradingSessionGuard', () => {
  it('allows orders during trading session', () => {
    const result = evaluateTradingSessionGuard({
      enforce: true,
      timezone: 'Asia/Shanghai',
      sessions: '09:30-11:30,13:00-15:00',
      now: new Date('2026-04-06T02:00:00.000Z'),
    });

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('within_trading_session');
    expect(result.nextOpenAt).toBeNull();
  });

  it('blocks orders during lunch break and points to the afternoon reopen', () => {
    const result = evaluateTradingSessionGuard({
      enforce: true,
      timezone: 'Asia/Shanghai',
      sessions: '09:30-11:30,13:00-15:00',
      now: new Date('2026-04-06T04:00:00.000Z'),
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('outside_trading_session');
    expect(result.nextOpenAt).toBe('2026-04-06T05:00:00.000Z');
    expect(result.message).toContain('非交易时段');
  });

  it('blocks orders after close and points to the next trading day open', () => {
    const result = evaluateTradingSessionGuard({
      enforce: true,
      timezone: 'Asia/Shanghai',
      sessions: '09:30-11:30,13:00-15:00',
      now: new Date('2026-04-06T08:00:00.000Z'),
    });

    expect(result.allowed).toBe(false);
    expect(result.nextOpenAt).toBe('2026-04-07T01:30:00.000Z');
  });

  it('blocks weekend orders and points to the next weekday open', () => {
    const result = evaluateTradingSessionGuard({
      enforce: true,
      timezone: 'Asia/Shanghai',
      sessions: '09:30-11:30,13:00-15:00',
      now: new Date('2026-04-05T02:00:00.000Z'),
    });

    expect(result.allowed).toBe(false);
    expect(result.nextOpenAt).toBe('2026-04-06T01:30:00.000Z');
  });
});
