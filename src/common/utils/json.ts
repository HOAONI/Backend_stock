/** 通用工具集合中的实现文件，承载该领域的具体逻辑。 */

export function safeJsonParse<T = unknown>(value: string | null | undefined, fallback: T): T {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'json_serialize_failed' });
  }
}
