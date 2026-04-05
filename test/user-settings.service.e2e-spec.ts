/** 用户设置服务单测，覆盖 SiliconFlow 个人绑定的回显、保存、清理与字段隔离。 */

import { UserSettingsService } from '../src/modules/user-settings/user-settings.service';

const SILICONFLOW_BASE_URL = 'https://api.siliconflow.cn/v1';
const SYSTEM_DEFAULT = {
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  hasToken: true,
  source: 'system_config' as const,
};

// 统一构造一份用户画像，便于不同测试只覆盖 AI 相关字段的变化。
function createProfile(overrides?: Record<string, unknown>) {
  return {
    id: 1,
    userId: 7,
    simulationAccountName: '',
    simulationAccountId: '',
    simulationInitialCapital: 100000,
    simulationNote: '',
    aiProvider: 'deepseek',
    aiBaseUrl: '',
    aiModel: '',
    aiTokenCiphertext: null,
    aiTokenIv: null,
    aiTokenTag: null,
    strategyPositionMaxPct: 30,
    strategyStopLossPct: 8,
    strategyTakeProfitPct: 15,
    strategyRiskProfile: 'balanced',
    strategyAnalysisStrategy: 'auto',
    strategyMaxSingleTradeAmount: null,
    agentChatPreferencesJson: null,
    createdAt: new Date('2026-03-13T00:00:00.000Z'),
    updatedAt: new Date('2026-03-13T00:00:00.000Z'),
    ...overrides,
  };
}

// 模拟运行时解析结果，让断言关注“保存后对外回显成什么”而不是底层解密实现。
function createAiRuntimeMock() {
  return {
    resolveEffectiveLlmFromProfile: jest.fn(async (profile: Record<string, unknown> | null) => {
      if (profile?.aiProvider === 'siliconflow' && profile?.aiTokenCiphertext) {
        return {
          source: 'personal',
          hasPersonalToken: true,
          hasSystemToken: true,
          personalProvider: 'siliconflow',
          systemDefault: SYSTEM_DEFAULT,
          effective: {
            provider: 'siliconflow',
            baseUrl: SILICONFLOW_BASE_URL,
            model: String(profile.aiModel || ''),
          },
          apiToken: null,
          requiresProviderReselection: false,
          forwardRuntimeLlm: true,
        };
      }

      return {
        source: 'system',
        hasPersonalToken: Boolean(profile?.aiTokenCiphertext),
        hasSystemToken: true,
        personalProvider: profile?.aiProvider === 'siliconflow'
          ? 'siliconflow'
          : (profile?.aiProvider === 'openai' || profile?.aiProvider === 'deepseek' ? profile.aiProvider : ''),
        systemDefault: SYSTEM_DEFAULT,
        effective: {
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o-mini',
        },
        apiToken: null,
        requiresProviderReselection: false,
        forwardRuntimeLlm: true,
      };
    }),
  };
}

// 个人密钥加解密只保留行为轮廓，避免测试被真实加密细节耦住。
function createPersonalCryptoMock(overrides?: Partial<{
  getStatus: jest.Mock
  encrypt: jest.Mock
  decrypt: jest.Mock
}>) {
  return {
    getStatus: jest.fn(() => ({ available: true, issue: '' })),
    encrypt: jest.fn(() => ({ ciphertext: 'cipher', iv: 'iv', tag: 'tag' })),
    decrypt: jest.fn(() => 'stored-personal-token'),
    ...overrides,
  };
}

describe('UserSettingsService', () => {
  it('echoes saved SiliconFlow provider and personal model even when runtime falls back to system', async () => {
    const profile = createProfile({
      aiProvider: 'siliconflow',
      aiBaseUrl: SILICONFLOW_BASE_URL,
      aiModel: 'Qwen/Qwen3-32B',
    });
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => profile),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock() as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.getMySettings(7) as Record<string, any>;

    expect(payload.ai.personalProvider).toBe('siliconflow');
    expect(payload.ai.personalModel).toBe('Qwen/Qwen3-32B');
    expect(payload.ai.source).toBe('system');
    expect(payload.ai.hasToken).toBe(false);
    expect(payload.ai.apiToken).toBe('');
    expect(payload.ai.apiTokenReadable).toBe(true);
    expect(payload.ai.apiTokenReadIssue).toBe('');
    expect(payload.ai.personalBindingAvailable).toBe(true);
    expect(payload.ai.personalBindingIssue).toBe('');
    expect(payload.agentChat).toEqual({
      executionPolicy: 'auto_execute_if_condition_met',
      confirmationShortcutsEnabled: true,
      followupFocusResolutionEnabled: true,
      responseStyle: 'concise_factual',
    });
  });

  it('persists SiliconFlow base url and model, then returns the saved personal config', async () => {
    const existing = createProfile();
    const updated = createProfile({
      aiProvider: 'siliconflow',
      aiBaseUrl: SILICONFLOW_BASE_URL,
      aiModel: 'Qwen/Qwen3-32B',
      aiTokenCiphertext: 'cipher',
      aiTokenIv: 'iv',
      aiTokenTag: 'tag',
      updatedAt: new Date('2026-03-13T01:00:00.000Z'),
    });
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => existing),
        update: jest.fn(async () => updated),
      },
    } as any;
    const personalCrypto = createPersonalCryptoMock({
      decrypt: jest.fn(() => 'silicon-key-1234567890'),
    });
    const service = new UserSettingsService(prisma, personalCrypto as any, createAiRuntimeMock() as any);

    const payload = await service.updateMySettings(7, {
      ai: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-32B',
        apiToken: 'silicon-key-1234567890',
      },
    } as any) as Record<string, any>;

    expect(prisma.adminUserProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        aiProvider: 'siliconflow',
        aiBaseUrl: SILICONFLOW_BASE_URL,
        aiModel: 'Qwen/Qwen3-32B',
      }),
    }));
    expect(payload.ai.personalProvider).toBe('siliconflow');
    expect(payload.ai.personalModel).toBe('Qwen/Qwen3-32B');
    expect(payload.ai.source).toBe('personal');
    expect(payload.ai.apiToken).toBe('silicon-key-1234567890');
    expect(payload.ai.apiTokenReadable).toBe(true);
    expect(payload.ai.apiTokenReadIssue).toBe('');
    expect(payload.ai.apiTokenMasked).toBe('******');
    expect(payload.ai.personalBindingAvailable).toBe(true);
    expect(personalCrypto.encrypt).toHaveBeenCalledWith('silicon-key-1234567890');
    expect(personalCrypto.decrypt).toHaveBeenCalledWith({
      ciphertext: 'cipher',
      iv: 'iv',
      tag: 'tag',
    });
  });

  it('clears stored SiliconFlow model fields when switching back to OpenAI', async () => {
    const existing = createProfile({
      aiProvider: 'siliconflow',
      aiBaseUrl: SILICONFLOW_BASE_URL,
      aiModel: 'Qwen/Qwen3-32B',
      aiTokenCiphertext: 'cipher',
      aiTokenIv: 'iv',
      aiTokenTag: 'tag',
    });
    const updated = createProfile({
      aiProvider: 'openai',
      aiBaseUrl: '',
      aiModel: '',
      aiTokenCiphertext: null,
      aiTokenIv: null,
      aiTokenTag: null,
      updatedAt: new Date('2026-03-13T02:00:00.000Z'),
    });
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => existing),
        update: jest.fn(async () => updated),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock() as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.updateMySettings(7, {
      ai: {
        provider: 'openai',
        apiToken: '',
      },
    } as any) as Record<string, any>;

    expect(prisma.adminUserProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        aiProvider: 'openai',
        aiBaseUrl: '',
        aiModel: '',
      }),
    }));
    expect(payload.ai.personalProvider).toBe('openai');
    expect(payload.ai.personalModel).toBe('');
    expect(payload.ai.source).toBe('system');
    expect(payload.ai.apiToken).toBe('');
    expect(payload.ai.apiTokenReadable).toBe(true);
    expect(payload.ai.apiTokenReadIssue).toBe('');
  });

  it('keeps simulation and strategy fields untouched when only ai payload is submitted', async () => {
    const existing = createProfile({
      simulationAccountName: 'SIM-A',
      simulationAccountId: 'SIM-001',
      simulationInitialCapital: 150000,
      simulationNote: 'keep-me',
      strategyPositionMaxPct: 45,
      strategyStopLossPct: 6,
      strategyTakeProfitPct: 20,
    });
    const updated = createProfile({
      simulationAccountName: 'SIM-A',
      simulationAccountId: 'SIM-001',
      simulationInitialCapital: 150000,
      simulationNote: 'keep-me',
      strategyPositionMaxPct: 45,
      strategyStopLossPct: 6,
      strategyTakeProfitPct: 20,
      aiProvider: 'siliconflow',
      aiBaseUrl: SILICONFLOW_BASE_URL,
      aiModel: 'Qwen/Qwen3-32B',
      aiTokenCiphertext: 'cipher',
      aiTokenIv: 'iv',
      aiTokenTag: 'tag',
      updatedAt: new Date('2026-03-13T03:00:00.000Z'),
    });
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => existing),
        update: jest.fn(async () => updated),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock() as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.updateMySettings(7, {
      ai: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-32B',
        apiToken: 'silicon-key-1234567890',
      },
    } as any) as Record<string, any>;

    expect(prisma.adminUserProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        simulationAccountName: undefined,
        simulationAccountId: undefined,
        simulationInitialCapital: undefined,
        simulationNote: undefined,
        strategyPositionMaxPct: undefined,
        strategyStopLossPct: undefined,
        strategyTakeProfitPct: undefined,
      }),
    }));
    expect(payload.simulation).toEqual({
      accountName: 'SIM-A',
      accountId: 'SIM-001',
      initialCapital: 150000,
      note: 'keep-me',
    });
    expect(payload.strategy).toEqual({
      riskProfile: 'balanced',
      analysisStrategy: 'auto',
      maxSingleTradeAmount: null,
      positionMaxPct: 45,
      stopLossPct: 6,
      takeProfitPct: 20,
    });
    expect(payload.ai.apiToken).toBe('stored-personal-token');
    expect(payload.ai.apiTokenReadable).toBe(true);
  });

  it('reports personal binding availability when PERSONAL_SECRET_KEY is configured', async () => {
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => createProfile()),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock() as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.getMySettings(7) as Record<string, any>;

    expect(payload.ai.personalBindingAvailable).toBe(true);
    expect(payload.ai.personalBindingIssue).toBe('');
  });

  it('returns a readable validation error when PERSONAL_SECRET_KEY is missing during personal AI binding', async () => {
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => createProfile()),
        update: jest.fn(),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock({
        getStatus: jest.fn(() => ({
          available: false,
          issue: '后端尚未配置 PERSONAL_SECRET_KEY，请在 Backend_stock/.env 中配置有效的 PERSONAL_SECRET_KEY 后重启后端，可使用 openssl rand -hex 32 生成。',
        })),
      }) as any,
      createAiRuntimeMock() as any,
    );

    await expect(service.updateMySettings(7, {
      ai: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-32B',
        apiToken: 'silicon-key-1234567890',
      },
    } as any)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('Backend_stock/.env'),
    });

    expect(prisma.adminUserProfile.update).not.toHaveBeenCalled();
  });

  it('reports binding unavailable state in settings payload when PERSONAL_SECRET_KEY is missing', async () => {
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => createProfile()),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock({
        getStatus: jest.fn(() => ({
          available: false,
          issue: '后端尚未配置 PERSONAL_SECRET_KEY，请在 Backend_stock/.env 中配置有效的 PERSONAL_SECRET_KEY 后重启后端，可使用 openssl rand -hex 32 生成。',
        })),
      }) as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.getMySettings(7) as Record<string, any>;

    expect(payload.ai.personalBindingAvailable).toBe(false);
    expect(payload.ai.personalBindingIssue).toContain('PERSONAL_SECRET_KEY');
  });

  it('keeps settings page readable when stored personal token cannot be decrypted', async () => {
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => createProfile({
          aiProvider: 'openai',
          aiTokenCiphertext: 'cipher',
          aiTokenIv: 'iv',
          aiTokenTag: 'tag',
        })),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock({
        decrypt: jest.fn(() => {
          throw new Error('decrypt failed');
        }),
      }) as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.getMySettings(7) as Record<string, any>;

    expect(payload.ai.hasToken).toBe(true);
    expect(payload.ai.apiToken).toBe('');
    expect(payload.ai.apiTokenReadable).toBe(false);
    expect(payload.ai.apiTokenReadIssue).toContain('PERSONAL_SECRET_KEY');
  });

  it('persists and normalizes agent chat preferences alongside existing strategy defaults', async () => {
    const existing = createProfile({
      agentChatPreferencesJson: {
        executionPolicy: 'confirm_before_execute',
        confirmationShortcutsEnabled: false,
        followupFocusResolutionEnabled: false,
        responseStyle: 'balanced',
      },
    });
    const updated = createProfile({
      agentChatPreferencesJson: {
        executionPolicy: 'confirm_before_execute',
        confirmationShortcutsEnabled: true,
        followupFocusResolutionEnabled: false,
        responseStyle: 'detailed',
      },
      updatedAt: new Date('2026-03-13T04:00:00.000Z'),
    });
    const prisma = {
      adminUserProfile: {
        upsert: jest.fn(async () => existing),
        update: jest.fn(async () => updated),
      },
    } as any;
    const service = new UserSettingsService(
      prisma,
      createPersonalCryptoMock() as any,
      createAiRuntimeMock() as any,
    );

    const payload = await service.updateMySettings(7, {
      agentChat: {
        confirmationShortcutsEnabled: true,
        responseStyle: 'detailed',
      },
    } as any) as Record<string, any>;

    expect(prisma.adminUserProfile.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentChatPreferencesJson: {
          executionPolicy: 'confirm_before_execute',
          confirmationShortcutsEnabled: true,
          followupFocusResolutionEnabled: false,
          responseStyle: 'detailed',
        },
      }),
    }));
    expect(payload.agentChat).toEqual({
      executionPolicy: 'confirm_before_execute',
      confirmationShortcutsEnabled: true,
      followupFocusResolutionEnabled: false,
      responseStyle: 'detailed',
    });
  });
});
