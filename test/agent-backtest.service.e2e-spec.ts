/** Agent 回放回测服务单测，覆盖 llm 元信息回读与 refine 阶段运行时来源切换。 */

import { AgentBacktestService } from '../src/modules/backtest/agent-backtest.service';

function createAgentInterpretationServiceMock() {
  return {
    ensureAgentRunGroupInterpretation: jest.fn(async () => {}),
  };
}

// 统一伪造一条 run_group 行，便于分别覆盖 fast/refine/失败等不同阶段的行为。
function createRunGroupRow(overrides?: Record<string, unknown>) {
  return {
    id: 11,
    owner_user_id: 7,
    code: '600519',
    start_date: '2024-01-01',
    end_date: '2024-12-31',
    effective_start_date: '2024-01-02',
    effective_end_date: '2024-12-30',
    engine_version: 'agent_replay_v1',
    status: 'refining',
    phase: 'fast',
    request_hash: 'req-hash',
    active_result_version: 1,
    latest_result_version: 1,
    progress_pct: 55,
    message: 'fast_completed_waiting_refine',
    config_json: {
      initial_capital: 100000,
      commission_rate: 0.0003,
      slippage_bps: 2,
      enable_refine: true,
      runtime_strategy: {
        position_max_pct: 30,
        stop_loss_pct: 8,
        take_profit_pct: 15,
      },
      signal_profile_hash: 'signal-hash',
      signal_profile_version: 'agent_signal_profile_v1',
      snapshot_version: 1,
      runtime_llm: {
        provider: 'siliconflow',
        base_url: 'https://api.siliconflow.cn/v1',
        model: 'Pro/deepseek-ai/DeepSeek-V3.2',
        has_token: true,
      },
      runtime_llm_source: 'personal',
    },
    summary_json: {
      total_return_pct: 12.5,
    },
    diagnostics_json: {
      decision_source_breakdown: {
        llm_anchor: 12,
      },
    },
    fast_ready_at: '2026-03-14T10:43:52.000Z',
    completed_at: null,
    error_message: null,
    created_at: '2026-03-14T10:43:52.000Z',
    updated_at: '2026-03-14T10:43:52.000Z',
    ...overrides,
  };
}

// 模拟 AI 运行时解析结果，让测试聚焦“选个人配置还是系统配置”的分支判断。
function createResolvedRuntime(overrides?: Record<string, unknown>) {
  return {
    source: 'personal',
    hasPersonalToken: true,
    hasSystemToken: true,
    personalProvider: 'siliconflow',
    systemDefault: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      hasToken: true,
      source: 'agent_runtime',
    },
    effective: {
      provider: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'Pro/deepseek-ai/DeepSeek-V3.2',
    },
    apiToken: 'personal-silicon-token',
    requiresProviderReselection: false,
    forwardRuntimeLlm: true,
    ...overrides,
  };
}

describe('AgentBacktestService', () => {
  it('exposes llm_meta on run detail and preserves SiliconFlow provider label', async () => {
    const service = new AgentBacktestService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      createAgentInterpretationServiceMock() as any,
    );
    jest.spyOn(service as any, 'assertStorageReady').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadGroupRow').mockResolvedValue(createRunGroupRow());
    jest.spyOn(service as any, 'loadDailySteps').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadTrades').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadEquity').mockResolvedValue([]);

    const detail = await service.getAgentRunDetail({
      runGroupId: 11,
      requester: { userId: 7, includeAll: false },
    });

    expect(detail).toMatchObject({
      run_group_id: 11,
      llm_meta: {
        source: 'personal',
        provider: 'siliconflow',
        base_url: 'https://api.siliconflow.cn/v1',
        model: 'Pro/deepseek-ai/DeepSeek-V3.2',
      },
    });
  });

  it('includes llm_meta in history items', async () => {
    const row = createRunGroupRow({
      status: 'completed',
      phase: 'done',
      summary_json: {
        total_return_pct: 12.5,
        ai_interpretation: {
          version: 'v1',
          status: 'ready',
          verdict: '表现中等',
          summary: '该回放在样本区间内整体表现中等。',
        },
      },
      completed_at: '2026-03-14T10:45:14.000Z',
    });
    const prisma = {
      $queryRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce([{ count: 1n }])
        .mockResolvedValueOnce([row]),
    };
    const service = new AgentBacktestService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      createAgentInterpretationServiceMock() as any,
    );
    jest.spyOn(service as any, 'assertStorageReady').mockResolvedValue(undefined);

    const response = await service.listAgentRuns({
      page: 1,
      limit: 20,
      requester: { userId: 7, includeAll: false },
    });

    expect(response).toMatchObject({
      total: 1,
      items: [
        {
          run_group_id: 11,
          llm_meta: {
            source: 'personal',
            provider: 'siliconflow',
            base_url: 'https://api.siliconflow.cn/v1',
            model: 'Pro/deepseek-ai/DeepSeek-V3.2',
          },
          summary: {
            ai_interpretation: {
              status: 'ready',
            },
          },
        },
      ],
    });
  });

  it('lazy-hydrates missing ai_interpretation for completed detail views', async () => {
    const rowWithoutInterpretation = createRunGroupRow({
      status: 'completed',
      phase: 'done',
      summary_json: {
        total_return_pct: 12.5,
      },
      completed_at: '2026-03-14T10:45:14.000Z',
    });
    const rowWithInterpretation = createRunGroupRow({
      status: 'completed',
      phase: 'done',
      summary_json: {
        total_return_pct: 12.5,
        ai_interpretation: {
          version: 'v1',
          status: 'ready',
          verdict: '表现中等',
          summary: '该回放在样本区间内整体表现中等。',
        },
      },
      completed_at: '2026-03-14T10:45:14.000Z',
    });
    const interpretationService = {
      ensureAgentRunGroupInterpretation: jest.fn(async () => {}),
    };
    const service = new AgentBacktestService({} as any, {} as any, {} as any, {} as any, interpretationService as any);
    jest.spyOn(service as any, 'assertStorageReady').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'loadGroupRow')
      .mockResolvedValueOnce(rowWithoutInterpretation)
      .mockResolvedValueOnce(rowWithInterpretation);
    jest.spyOn(service as any, 'loadDailySteps').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadTrades').mockResolvedValue([]);
    jest.spyOn(service as any, 'loadEquity').mockResolvedValue([]);

    const detail = await service.getAgentRunDetail({
      runGroupId: 11,
      requester: { userId: 7, includeAll: false },
    });

    expect(interpretationService.ensureAgentRunGroupInterpretation).toHaveBeenCalledWith(11);
    expect(detail).toMatchObject({
      summary: {
        ai_interpretation: {
          status: 'ready',
        },
      },
    });
  });

  it('resolves system refine payload without inheriting the user personal binding', async () => {
    const prisma = {
      adminUserProfile: {
        findUnique: jest.fn(async () => ({
          userId: 7,
          aiProvider: 'siliconflow',
          aiBaseUrl: 'https://api.siliconflow.cn/v1',
          aiModel: 'Pro/deepseek-ai/DeepSeek-V3.2',
          aiTokenCiphertext: 'ciphertext',
          aiTokenIv: 'iv',
          aiTokenTag: 'tag',
        })),
      },
    };
    const aiRuntimeService = {
      resolveEffectiveLlmFromProfile: jest.fn(async (profile: Record<string, unknown> | null) => {
        if (profile?.aiTokenCiphertext) {
          return createResolvedRuntime();
        }
        return createResolvedRuntime({
          source: 'system',
          hasPersonalToken: false,
          personalProvider: '',
          effective: {
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
          },
          apiToken: 'system-openai-token',
        });
      }),
    };
    const service = new AgentBacktestService(
      prisma as any,
      {} as any,
      {} as any,
      aiRuntimeService as any,
      createAgentInterpretationServiceMock() as any,
    );

    const payload = await (service as any).resolveRefineRuntimeLlmPayload(7, 'system');

    expect(payload).toEqual({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      has_token: true,
      api_token: 'system-openai-token',
    });
    expect(aiRuntimeService.resolveEffectiveLlmFromProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        aiProvider: '',
        aiTokenCiphertext: null,
        aiTokenIv: null,
        aiTokenTag: null,
      }),
      expect.objectContaining({
        includeApiToken: true,
        requireSystemDefault: true,
      }),
    );
  });

  it('fails refine explicitly when a personal-source run can no longer resolve a live personal payload', async () => {
    const row = createRunGroupRow();
    const prisma = {
      $queryRawUnsafe: jest.fn(async () => [{ id: row.id }]),
      $executeRawUnsafe: jest
        .fn()
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(1),
      adminUserProfile: {
        findUnique: jest.fn(async () => ({
          userId: 7,
          aiProvider: 'siliconflow',
          aiBaseUrl: 'https://api.siliconflow.cn/v1',
          aiModel: 'Pro/deepseek-ai/DeepSeek-V3.2',
          aiTokenCiphertext: null,
          aiTokenIv: null,
          aiTokenTag: null,
        })),
      },
    };
    const backtestAgentClient = {
      agentRun: jest.fn(),
    };
    const aiRuntimeService = {
      resolveEffectiveLlmFromProfile: jest.fn(async () => createResolvedRuntime({
        source: 'system',
        hasPersonalToken: false,
        personalProvider: '',
        effective: {
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-chat',
        },
        apiToken: null,
        forwardRuntimeLlm: false,
      })),
    };
    const service = new AgentBacktestService(
      prisma as any,
      backtestAgentClient as any,
      {} as any,
      aiRuntimeService as any,
      createAgentInterpretationServiceMock() as any,
    );
    jest.spyOn(service as any, 'isStorageReady').mockResolvedValue(true);
    jest.spyOn(service as any, 'loadGroupRow').mockResolvedValue(row);
    jest.spyOn(service as any, 'loadArchivedNews').mockResolvedValue({});
    jest.spyOn(service as any, 'loadCachedSnapshots').mockResolvedValue([]);

    const processed = await service.processNextRefineJob();

    expect(processed).toBe(true);
    expect(backtestAgentClient.agentRun).not.toHaveBeenCalled();
    expect(prisma.$executeRawUnsafe).toHaveBeenLastCalledWith(
      expect.stringContaining('UPDATE "agent_backtest_run_groups"'),
      row.id,
      expect.stringContaining('为避免静默回退到系统 AI，本次精修已终止'),
    );
  });

  it('continues refine with a live personal runtime payload instead of the sanitized stored config', async () => {
    const row = createRunGroupRow();
    const prisma = {
      $queryRawUnsafe: jest.fn(async () => [{ id: row.id }]),
      $executeRawUnsafe: jest.fn(async () => 1),
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<void>) => await callback({})),
      adminUserProfile: {
        findUnique: jest.fn(async () => ({
          userId: 7,
          aiProvider: 'siliconflow',
          aiBaseUrl: 'https://api.siliconflow.cn/v1',
          aiModel: 'Pro/deepseek-ai/DeepSeek-V3.2',
          aiTokenCiphertext: 'ciphertext',
          aiTokenIv: 'iv',
          aiTokenTag: 'tag',
        })),
      },
    };
    const backtestAgentClient = {
      agentRun: jest.fn(async () => ({ ok: true })),
    };
    const aiRuntimeService = {
      resolveEffectiveLlmFromProfile: jest.fn(async () => createResolvedRuntime()),
    };
    const service = new AgentBacktestService(
      prisma as any,
      backtestAgentClient as any,
      {} as any,
      aiRuntimeService as any,
      createAgentInterpretationServiceMock() as any,
    );
    jest.spyOn(service as any, 'isStorageReady').mockResolvedValue(true);
    jest.spyOn(service as any, 'loadGroupRow').mockResolvedValue(row);
    jest.spyOn(service as any, 'loadArchivedNews').mockResolvedValue({});
    jest.spyOn(service as any, 'loadCachedSnapshots').mockResolvedValue([]);
    jest.spyOn(service as any, 'normalizeResult').mockReturnValue({
      code: '600519',
      engineVersion: 'agent_replay_v1',
      phase: 'refine',
      requestedRange: { startDate: '2024-01-01', endDate: '2024-12-31' },
      effectiveRange: { startDate: '2024-01-02', endDate: '2024-12-30' },
      summary: {},
      diagnostics: {},
      dailySteps: [],
      trades: [],
      equity: [],
      signalSnapshots: [],
      pendingAnchorDates: [],
    });
    jest.spyOn(service as any, 'persistResultVersion').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'upsertSignalSnapshots').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'updateRunGroup').mockResolvedValue(undefined);

    const processed = await service.processNextRefineJob();

    expect(processed).toBe(true);
    expect(backtestAgentClient.agentRun).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'refine',
      runtime_llm: {
        provider: 'custom',
        base_url: 'https://api.siliconflow.cn/v1',
        model: 'Pro/deepseek-ai/DeepSeek-V3.2',
        has_token: true,
        api_token: 'personal-silicon-token',
      },
    }));
  });
});
