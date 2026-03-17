/** 图像解析基础设施的服务层实现，负责汇总数据访问、业务规则和外部依赖编排。 */

import { Injectable } from '@nestjs/common';

const EXTRACT_PROMPT = `请分析这张股票市场截图或图片，提取其中所有可见的股票代码。

输出格式：仅返回有效的 JSON 数组字符串，不要 markdown、不要解释。
示例：
- A股（6位数字）：600519, 300750, 002594
- 港股（5位数字，可有前导零）：00700, 09988
- 美股（1-5字母）：AAPL, TSLA, MSFT

输出示例：["600519", "300750", "00700"]

若未找到任何股票代码，返回：[]`;

export const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** 负责承接该领域的核心业务编排，把数据库访问、规则判断和外部调用收拢到一处。 */
@Injectable()
export class ImageStockExtractorService {
  private normalizeCode(raw: string): string | null {
    const s = String(raw ?? '').trim().toUpperCase();
    if (!s) return null;

    if (/^\d{5,6}$/.test(s)) return s;
    if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(s)) return s;

    for (const suffix of ['.SH', '.SZ', '.SS']) {
      if (s.endsWith(suffix)) {
        const base = s.slice(0, -suffix.length);
        if (/^\d{5,6}$/.test(base)) return base;
      }
    }

    return null;
  }

  private parseCodes(text: string): string[] {
    const dedup = new Set<string>();

    const cleaned = text
      .replace(/```json/gi, '```')
      .split('```')
      .map((x) => x.trim())
      .find((x) => x.startsWith('[') && x.endsWith(']')) ?? text;

    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const code = this.normalizeCode(String(item));
          if (code) dedup.add(code);
        }
        return [...dedup];
      }
    } catch {
      // 模型返回的文本未必是严格 JSON；这里只是放弃 JSON 路径，继续走正则兜底提取。
    }

    const pattern = /\b([0-9]{5,6}|[A-Z]{1,5}(\.[A-Z])?)\b/gi;
    let match = pattern.exec(text);
    while (match) {
      const code = this.normalizeCode(match[1]);
      if (code) dedup.add(code);
      match = pattern.exec(text);
    }

    return [...dedup];
  }

  private verifyMagicBytes(buffer: Buffer, mimeType: string): void {
    if (buffer.length < 12) {
      throw new Error('图片文件过小或损坏');
    }

    if (mimeType === 'image/jpeg' && !buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      throw new Error('文件内容与声明类型不匹配');
    }
    if (mimeType === 'image/png' && !buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error('文件内容与声明类型不匹配');
    }
    if (mimeType === 'image/gif') {
      const header = buffer.subarray(0, 6).toString('ascii');
      if (header !== 'GIF87a' && header !== 'GIF89a') {
        throw new Error('文件内容与声明类型不匹配');
      }
    }
    if (mimeType === 'image/webp') {
      const riff = buffer.subarray(0, 4).toString('ascii');
      const webp = buffer.subarray(8, 12).toString('ascii');
      if (riff !== 'RIFF' || webp !== 'WEBP') {
        throw new Error('文件内容与声明类型不匹配');
      }
    }
  }

  private isKeyValid(value: string | undefined): boolean {
    const trimmed = String(value ?? '').trim();
    return trimmed.length > 10 && !trimmed.startsWith('your_');
  }

  private async callGemini(imageB64: string, mimeType: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey ?? '')}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: EXTRACT_PROMPT },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: imageB64,
                  },
                },
              ],
            },
          ],
        }),
      },
    );

    const payload = (await response.json()) as any;
    if (!response.ok) {
      throw new Error(payload?.error?.message || 'Gemini request failed');
    }

    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini returned empty response');
    }
    return String(text);
  }

  private async callAnthropic(imageB64: string, mimeType: string): Promise<string> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: imageB64,
                },
              },
              {
                type: 'text',
                text: EXTRACT_PROMPT,
              },
            ],
          },
        ],
      }),
    });

    const payload = (await response.json()) as any;
    if (!response.ok) {
      throw new Error(payload?.error?.message || 'Anthropic request failed');
    }

    const text = payload?.content?.[0]?.text;
    if (!text) {
      throw new Error('Anthropic returned empty response');
    }

    return String(text);
  }

  private async callOpenAI(imageB64: string, mimeType: string): Promise<string> {
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const model = process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: EXTRACT_PROMPT,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${imageB64}`,
                },
              },
            ],
          },
        ],
      }),
    });

    const payload = (await response.json()) as any;
    if (!response.ok) {
      throw new Error(payload?.error?.message || 'OpenAI request failed');
    }

    const text = payload?.choices?.[0]?.message?.content;
    if (!text) {
      throw new Error('OpenAI returned empty response');
    }

    return String(text);
  }

  async extractCodes(buffer: Buffer, mimeType: string): Promise<{ codes: string[]; rawText: string }> {
    const normalizedMime = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(normalizedMime)) {
      throw new Error(`不支持的图片类型: ${normalizedMime}`);
    }

    if (!buffer || buffer.length === 0) {
      throw new Error('图片内容为空');
    }

    if (buffer.length > MAX_SIZE_BYTES) {
      throw new Error(`Image too large (max ${Math.floor(MAX_SIZE_BYTES / 1024 / 1024)}MB)`);
    }

    this.verifyMagicBytes(buffer, normalizedMime);
    const imageB64 = buffer.toString('base64');

    const providers: Array<'gemini' | 'anthropic' | 'openai'> = [];
    if (this.isKeyValid(process.env.GEMINI_API_KEY)) providers.push('gemini');
    if (this.isKeyValid(process.env.ANTHROPIC_API_KEY)) providers.push('anthropic');
    if (this.isKeyValid(process.env.OPENAI_API_KEY)) providers.push('openai');

    if (providers.length === 0) {
      throw new Error('未配置 Vision API。请设置 GEMINI_API_KEY、ANTHROPIC_API_KEY 或 OPENAI_API_KEY。');
    }

    let lastError: Error | null = null;
    for (const provider of providers) {
      try {
        let rawText = '';
        if (provider === 'gemini') rawText = await this.callGemini(imageB64, normalizedMime);
        if (provider === 'anthropic') rawText = await this.callAnthropic(imageB64, normalizedMime);
        if (provider === 'openai') rawText = await this.callOpenAI(imageB64, normalizedMime);

        return {
          codes: this.parseCodes(rawText),
          rawText,
        };
      } catch (error) {
        lastError = error as Error;
      }
    }

    throw new Error(lastError?.message || '所有 Vision API 均调用失败，请检查 API Key 与网络。');
  }
}
