import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AiRuntimeService } from '../src/common/ai/ai-runtime.service';

describe('AiRuntimeService', () => {
  let tempDir: string;
  let originalAgentEnvFile: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-runtime-'));
    originalAgentEnvFile = process.env.AGENT_ENV_FILE;
    process.env.AGENT_ENV_FILE = path.join(tempDir, '.env');
  });

  afterEach(() => {
    if (originalAgentEnvFile == null) {
      delete process.env.AGENT_ENV_FILE;
    } else {
      process.env.AGENT_ENV_FILE = originalAgentEnvFile;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const createService = (input?: {
    configValues?: Record<string, string>;
    agentDefault?: Record<string, unknown>;
    decrypted?: string;
  }) =>
    new AiRuntimeService(
      {
        getValueMap: jest.fn(async () => input?.configValues ?? {}),
      } as any,
      {
        decrypt: jest.fn(() => input?.decrypted ?? 'personal-token-xyz'),
      } as any,
      {
        getRuntimeLlmDefault: jest.fn(async () => input?.agentDefault ?? {
          available: false,
          has_token: false,
        }),
      } as any,
    );

  it('prefers personal provider preset and personal token when user saved a supported personal config', async () => {
    const service = createService({
      agentDefault: {
        available: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        base_url: 'https://api.deepseek.com/v1',
        has_token: true,
      },
    });

    const resolved = await service.resolveEffectiveLlmFromProfile({
      aiProvider: 'openai',
      aiTokenCiphertext: 'ciphertext',
      aiTokenIv: 'iv',
      aiTokenTag: 'tag',
    } as any, {
      includeApiToken: true,
      requireSystemDefault: true,
    });

    expect(resolved.source).toBe('personal');
    expect(resolved.personalProvider).toBe('openai');
    expect(resolved.forwardRuntimeLlm).toBe(true);
    expect(resolved.apiToken).toBe('personal-token-xyz');
    expect(resolved.effective).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('resolves SiliconFlow personal config with stored model and fixed base url', async () => {
    const service = createService({
      agentDefault: {
        available: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        base_url: 'https://api.deepseek.com/v1',
        has_token: true,
      },
    });

    const resolved = await service.resolveEffectiveLlmFromProfile({
      aiProvider: 'siliconflow',
      aiModel: 'Qwen/Qwen3-32B',
      aiTokenCiphertext: 'ciphertext',
      aiTokenIv: 'iv',
      aiTokenTag: 'tag',
    } as any, {
      includeApiToken: true,
      requireSystemDefault: true,
    });

    expect(resolved.source).toBe('personal');
    expect(resolved.personalProvider).toBe('siliconflow');
    expect(resolved.forwardRuntimeLlm).toBe(true);
    expect(resolved.apiToken).toBe('personal-token-xyz');
    expect(resolved.effective).toEqual({
      provider: 'siliconflow',
      model: 'Qwen/Qwen3-32B',
      baseUrl: 'https://api.siliconflow.cn/v1',
    });
  });

  it('falls back to the Agent built-in default when no personal token exists', async () => {
    const service = createService({
      agentDefault: {
        available: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        base_url: 'https://api.deepseek.com/v1',
        has_token: true,
      },
    });

    const resolved = await service.resolveEffectiveLlmFromProfile(null, {
      includeApiToken: true,
      requireSystemDefault: true,
    });

    expect(resolved.source).toBe('system');
    expect(resolved.forwardRuntimeLlm).toBe(false);
    expect(resolved.apiToken).toBeNull();
    expect(resolved.effective).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(resolved.systemDefault.hasToken).toBe(true);
  });

  it('falls back to backend system config when Agent default metadata is unavailable', async () => {
    const service = createService({
      configValues: {
        OPENAI_API_KEY: 'openai-system-key-123456',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_MODEL: 'gpt-4o-mini',
      },
    });

    const resolved = await service.resolveEffectiveLlmFromProfile(null, {
      includeApiToken: true,
      requireSystemDefault: true,
    });

    expect(resolved.source).toBe('system');
    expect(resolved.forwardRuntimeLlm).toBe(true);
    expect(resolved.apiToken).toBe('openai-system-key-123456');
    expect(resolved.effective).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(resolved.systemDefault.source).toBe('system_config');
  });

  it('falls back to local Agent env when runtime Agent metadata is unavailable', async () => {
    fs.writeFileSync(
      process.env.AGENT_ENV_FILE!,
      [
        'OPENAI_API_KEY=deepseek-system-key-123456',
        'OPENAI_BASE_URL=https://api.deepseek.com/v1',
        'OPENAI_MODEL=deepseek-chat',
      ].join('\n'),
      'utf8',
    );

    const service = createService();

    const resolved = await service.resolveEffectiveLlmFromProfile(null, {
      includeApiToken: true,
      requireSystemDefault: true,
    });

    expect(resolved.source).toBe('system');
    expect(resolved.forwardRuntimeLlm).toBe(false);
    expect(resolved.apiToken).toBeNull();
    expect(resolved.effective).toEqual({
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(resolved.systemDefault.source).toBe('agent_env_fallback');
  });

  it('marks legacy personal providers as requiring reselection and falls back to system', async () => {
    const service = createService({
      agentDefault: {
        available: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        base_url: 'https://api.deepseek.com/v1',
        has_token: true,
      },
    });

    const resolved = await service.resolveEffectiveLlmFromProfile({
      aiProvider: 'gemini',
      aiTokenCiphertext: 'ciphertext',
      aiTokenIv: 'iv',
      aiTokenTag: 'tag',
    } as any, {
      includeApiToken: true,
      requireSystemDefault: true,
    });

    expect(resolved.source).toBe('system');
    expect(resolved.requiresProviderReselection).toBe(true);
    expect(resolved.personalProvider).toBe('');
    expect(resolved.apiToken).toBeNull();
    expect(resolved.effective.provider).toBe('deepseek');
  });

  it('throws when no Agent default or backend system default is available and personal config is unusable', async () => {
    const service = createService();

    await expect(service.resolveEffectiveLlmFromProfile(null, {
      includeApiToken: true,
      requireSystemDefault: true,
    })).rejects.toThrow('系统内置 AI 未配置');
  });
});
