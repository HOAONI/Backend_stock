/** 通用工具集合中的实现文件，承载交易时段守卫逻辑。 */

export interface TradingSessionWindow {
  start: number;
  end: number;
  label: string;
}

export interface TradingSessionGuardResult {
  allowed: boolean;
  reason: 'within_trading_session' | 'outside_trading_session' | 'session_guard_disabled' | 'session_guard_not_configured';
  message: string;
  timezone: string;
  sessions: string[];
  evaluatedAt: string;
  nextOpenAt: string | null;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

interface TradingSessionGuardOptions {
  enforce?: boolean;
  timezone?: string;
  sessions?: string;
  now?: Date;
}

export const DEFAULT_TRADING_SESSION_TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_TRADING_SESSION_WINDOWS = '09:30-11:30,13:00-15:00';

function normalizeTimezone(value: string | undefined): string {
  const fallback = DEFAULT_TRADING_SESSION_TIMEZONE;
  const timezone = String(value ?? '').trim() || fallback;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return fallback;
  }
}

export function parseTradingSessions(raw: string): TradingSessionWindow[] {
  return String(raw ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.includes('-'))
    .map((item) => {
      const [startRaw, endRaw] = item.split('-', 2).map(text => text.trim());
      const [startHour, startMinute] = startRaw.split(':', 2);
      const [endHour, endMinute] = endRaw.split(':', 2);
      const start = Number(startHour) * 60 + Number(startMinute);
      const end = Number(endHour) * 60 + Number(endMinute);
      return {
        start,
        end,
        label: `${startRaw}-${endRaw}`,
      };
    })
    .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.start >= 0 && item.end > item.start);
}

function resolveWeekday(raw: string): number {
  const weekday = String(raw ?? '').trim().toLowerCase();
  if (weekday === 'sun') return 0;
  if (weekday === 'mon') return 1;
  if (weekday === 'tue') return 2;
  if (weekday === 'wed') return 3;
  if (weekday === 'thu') return 4;
  if (weekday === 'fri') return 5;
  return 6;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    String(parts.find(item => item.type === type)?.value ?? '').trim();

  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')),
    minute: Number(read('minute')),
    second: Number(read('second')),
    weekday: resolveWeekday(read('weekday')),
  };
}

function addLocalDays(year: number, month: number, day: number, deltaDays: number): { year: number; month: number; day: number } {
  const next = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function buildUtcDateForLocalTime(
  timezone: string,
  input: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
): Date {
  let guess = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second ?? 0));
  const desiredUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second ?? 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getZonedDateParts(guess, timezone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const diff = desiredUtc - actualUtc;
    if (diff === 0) {
      return guess;
    }
    guess = new Date(guess.getTime() + diff);
  }

  return guess;
}

function formatZonedDateTime(date: Date, timezone: string): string {
  const parts = getZonedDateParts(date, timezone);
  const year = String(parts.year);
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  const hour = String(parts.hour).padStart(2, '0');
  const minute = String(parts.minute).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function resolveNextOpenAt(now: Date, timezone: string, sessions: TradingSessionWindow[]): Date | null {
  const current = getZonedDateParts(now, timezone);
  const currentMinutes = current.hour * 60 + current.minute;

  for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
    const targetDate = addLocalDays(current.year, current.month, current.day, dayOffset);
    const weekday = new Date(Date.UTC(targetDate.year, targetDate.month - 1, targetDate.day)).getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }

    const candidateWindow = dayOffset === 0
      ? sessions.find(window => window.start > currentMinutes)
      : sessions[0];

    if (!candidateWindow) {
      continue;
    }

    return buildUtcDateForLocalTime(timezone, {
      year: targetDate.year,
      month: targetDate.month,
      day: targetDate.day,
      hour: Math.floor(candidateWindow.start / 60),
      minute: candidateWindow.start % 60,
      second: 0,
    });
  }

  return null;
}

export function evaluateTradingSessionGuard(options: TradingSessionGuardOptions = {}): TradingSessionGuardResult {
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const enforce = options.enforce ?? true;
  const sessions = parseTradingSessions(options.sessions ?? DEFAULT_TRADING_SESSION_WINDOWS);
  const sessionLabels = sessions.map(item => item.label);

  if (!enforce) {
    return {
      allowed: true,
      reason: 'session_guard_disabled',
      message: '交易时段守卫已关闭，可直接提交模拟盘订单。',
      timezone,
      sessions: sessionLabels,
      evaluatedAt: now.toISOString(),
      nextOpenAt: null,
    };
  }

  if (sessions.length === 0) {
    return {
      allowed: true,
      reason: 'session_guard_not_configured',
      message: '交易时段未配置，当前默认允许提交模拟盘订单。',
      timezone,
      sessions: [],
      evaluatedAt: now.toISOString(),
      nextOpenAt: null,
    };
  }

  const current = getZonedDateParts(now, timezone);
  const currentMinutes = current.hour * 60 + current.minute;
  const isWeekend = current.weekday === 0 || current.weekday === 6;
  const inSession = !isWeekend && sessions.some(window => window.start <= currentMinutes && currentMinutes < window.end);

  if (inSession) {
    return {
      allowed: true,
      reason: 'within_trading_session',
      message: '当前处于交易时段，可直接提交模拟盘订单。',
      timezone,
      sessions: sessionLabels,
      evaluatedAt: now.toISOString(),
      nextOpenAt: null,
    };
  }

  const nextOpen = resolveNextOpenAt(now, timezone, sessions);
  const nextOpenAt = nextOpen?.toISOString() ?? null;
  const nextOpenText = nextOpen ? formatZonedDateTime(nextOpen, timezone) : '下一个交易时段';
  const sessionText = sessionLabels.join('、');

  return {
    allowed: false,
    reason: 'outside_trading_session',
    message: `当前处于非交易时段（${timezone}，交易时段 ${sessionText}）。本轮未执行模拟盘订单，候选单已保留，请在 ${nextOpenText} 后再次确认。`,
    timezone,
    sessions: sessionLabels,
    evaluatedAt: now.toISOString(),
    nextOpenAt,
  };
}

export function evaluateTradingSessionGuardFromEnv(now: Date = new Date()): TradingSessionGuardResult {
  return evaluateTradingSessionGuard({
    now,
    enforce: (process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION ?? 'true').toLowerCase() === 'true',
    timezone: process.env.ANALYSIS_AUTO_ORDER_TIMEZONE ?? DEFAULT_TRADING_SESSION_TIMEZONE,
    sessions: process.env.ANALYSIS_AUTO_ORDER_TRADING_SESSIONS ?? DEFAULT_TRADING_SESSION_WINDOWS,
  });
}
