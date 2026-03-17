/** 认证与审计基础设施的常量定义，集中维护默认值与约束边界。 */

export const COOKIE_NAME = 'dsa_session';
export const SESSION_MAX_AGE_HOURS_DEFAULT = 24;
export const MIN_PASSWORD_LEN = 6;
export const PBKDF2_ITERATIONS = 100_000;
export const RATE_LIMIT_WINDOW_SEC = 300;
export const RATE_LIMIT_MAX_FAILURES = 5;
export const DEFAULT_ADMIN_REGISTER_SECRET = '123123';
