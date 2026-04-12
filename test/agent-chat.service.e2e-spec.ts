/** Agent 问股服务单测，覆盖用户偏好注入到 Agent 载荷。 */
import { AgentChatService } from '../src/modules/agent-chat/agent-chat.service';

describe('AgentChatService', () => {
  it('injects normalized agent chat preferences into chat payload context', async () => {
    const agentClient = {
      createChat: jest.fn(async payload => payload),
    };
    const prisma = {
      adminUserProfile: {
        findUnique: jest.fn(async () => ({
          agentChatPreferencesJson: {
            executionPolicy: 'confirm_before_execute',
            confirmationShortcutsEnabled: false,
            followupFocusResolutionEnabled: false,
            responseStyle: 'balanced',
          },
        })),
      },
      analysisHistory: {},
      analysisTask: {},
      strategyBacktestRunGroup: {},
      agentBacktestRunGroup: {},
    };
    const analysisService = {
      buildRuntimeContext: jest.fn(async () => ({
        runtimeConfig: {
          account: {
            account_name: 'tester',
            initial_cash: 100000,
          },
          strategy: {
            position_max_pct: 30,
            stop_loss_pct: 8,
            take_profit_pct: 15,
          },
        },
      })),
    };
    const brokerAccountsService = {
      getMySimulationAccountStatus: jest.fn(async () => ({
        is_bound: true,
        is_verified: true,
        broker_account_id: 7,
      })),
    };
    const tradingAccountService = {
      getRuntimeContext: jest.fn(async () => ({
        broker_account_id: 7,
        provider_code: 'backtrader_local',
        provider_name: 'Backtrader Local Sim',
        account_uid: 'bt-7',
        account_display_name: 'tester-paper',
        snapshot_at: '2026-04-03T09:30:00+08:00',
        data_source: 'cache',
        summary: {
          cash: 100000,
          initial_capital: 100000,
          total_market_value: 0,
          total_asset: 100000,
        },
        positions: [],
      })),
    };

    const service = new AgentChatService(
      agentClient as any,
      prisma as any,
      analysisService as any,
      brokerAccountsService as any,
      tradingAccountService as any,
    );

    await service.chat(7, 'tester', {
      message: '分析 300750，风险低的话帮我买100股',
      context: {
        stock_code: '300750',
      },
    } as any);

    expect(agentClient.createChat).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        stock_code: '300750',
        simulation_account: expect.objectContaining({
          broker_account_id: 7,
        }),
        agent_chat_preferences: {
          executionPolicy: 'confirm_before_execute',
          confirmationShortcutsEnabled: false,
          followupFocusResolutionEnabled: false,
          responseStyle: 'balanced',
        },
      }),
    }));
  });

  it('builds effective user preferences with session overrides for agent tools', async () => {
    const service = new AgentChatService(
      {} as any,
      {
        adminUserProfile: {
          findUnique: jest.fn(async () => ({
            strategyRiskProfile: 'conservative',
            strategyAnalysisStrategy: 'auto',
            strategyMaxSingleTradeAmount: null,
            strategyPositionMaxPct: 30,
            strategyStopLossPct: 8,
            strategyTakeProfitPct: 15,
            agentChatPreferencesJson: {
              executionPolicy: 'auto_execute_if_condition_met',
              confirmationShortcutsEnabled: true,
              followupFocusResolutionEnabled: true,
              responseStyle: 'concise_factual',
            },
          })),
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const payload = await service.getUserPreferencesForAgent(7, {
      riskProfile: 'aggressive',
      analysisStrategy: 'rsi',
      maxSingleTradeAmount: 20000,
    });

    expect(payload.effective).toEqual(expect.objectContaining({
      trading: expect.objectContaining({
        riskProfile: 'aggressive',
        analysisStrategy: 'rsi',
        maxSingleTradeAmount: 20000,
        positionMaxPct: 30,
        stopLossPct: 8,
        takeProfitPct: 15,
      }),
    }));
    expect(payload.source).toEqual(expect.objectContaining({
      trading: expect.objectContaining({
        riskProfile: 'session',
        analysisStrategy: 'session',
        maxSingleTradeAmount: 'session',
      }),
    }));
  });

  it('returns agent account state with runtime snapshot passthrough', async () => {
    const tradingAccountService = {
      getRuntimeContext: jest.fn(async () => ({
        broker_account_id: 7,
        provider_code: 'backtrader_local',
        provider_name: 'Backtrader Local Sim',
        account_uid: 'bt-7',
        account_display_name: 'tester-paper',
        snapshot_at: '2026-04-03T09:30:00+08:00',
        data_source: 'cache',
        summary: {
          cash: 100000,
          initial_capital: 100000,
          total_market_value: 336000,
          total_asset: 436000,
        },
        positions: [],
      })),
      getAccountState: jest.fn(async () => ({
        broker_account_id: 7,
        provider_code: 'backtrader_local',
        provider_name: 'Backtrader Local Sim',
        account_uid: 'bt-7',
        account_display_name: 'tester-paper',
        snapshot_at: '2026-04-03T09:30:00+08:00',
        data_source: 'cache',
        positions: [
          {
            code: '600519',
            quantity: 200,
            available_qty: 100,
            avg_cost: 1600,
          },
        ],
        available_cash: 100000,
        total_market_value: 336000,
        total_asset: 436000,
        today_order_count: 2,
        today_trade_count: 1,
      })),
    };
    const service = new AgentChatService(
      {} as any,
      {} as any,
      {} as any,
      {
        getMySimulationAccountStatus: jest.fn(async () => ({
          is_bound: true,
          is_verified: true,
          broker_account_id: 7,
        })),
      } as any,
      tradingAccountService as any,
    );

    const payload = await service.getAccountStateForAgent(7, true);

    expect(payload.account_state).toEqual(expect.objectContaining({
      available_cash: 100000,
      total_asset: 436000,
      today_order_count: 2,
      today_trade_count: 1,
    }));
    expect(payload.runtime_context).toEqual(expect.objectContaining({
      broker_account_id: 7,
      summary: expect.objectContaining({
        total_asset: 436000,
      }),
    }));
  });

  it('runs ad-hoc strategy backtest for agent chat with inline template params', async () => {
    const runStrategyRange = jest.fn(async payload => ({
      run_group_id: 901,
      code: payload.code,
      requested_range: {
        start_date: payload.startDate,
        end_date: payload.endDate,
      },
      effective_range: {
        start_date: payload.startDate,
        end_date: payload.endDate,
      },
      items: [
        {
          run_id: 101,
          strategy_code: 'macd_cross',
          strategy_name: 'MACD 金叉',
          template_code: 'macd_cross',
          metrics: {
            total_return_pct: 18.6,
          },
        },
      ],
    }));
    const service = new AgentChatService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { runStrategyRange } as any,
    );

    const payload = await service.runStrategyBacktestForAgent(7, {
      code: '600519',
      startDate: '2025-04-05',
      endDate: '2026-04-05',
      strategies: [
        {
          strategy_name: 'MACD 金叉',
          template_code: 'macd_cross',
          params: {
            macdFast: 12,
            macdSlow: 26,
            macdSignal: 9,
          },
        },
      ],
      initialCapital: 100000,
    });

    expect(payload).toEqual(expect.objectContaining({
      code: '600519',
      run_group_id: 901,
    }));
    expect(runStrategyRange).toHaveBeenCalledWith(expect.objectContaining({
      code: '600519',
      startDate: '2025-04-05',
      endDate: '2026-04-05',
      strategies: [
        {
          strategy_name: 'MACD 金叉',
          template_code: 'macd_cross',
          params: {
            macdFast: 12,
            macdSlow: 26,
            macdSignal: 9,
          },
        },
      ],
      initialCapital: 100000,
      aiInterpretationMode: 'agent_managed',
      requester: {
        userId: 7,
        includeAll: false,
      },
    }));
  });

  it('persists agent-produced strategy backtest interpretations through the backtest ai service', async () => {
    const persistStrategyRunGroupInterpretationsFromAgent = jest.fn(async payload => ({
      ...payload,
      ai_interpretation_status: 'completed',
    }));
    const service = new AgentChatService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { persistStrategyRunGroupInterpretationsFromAgent } as any,
    );

    const payload = await service.saveStrategyBacktestInterpretationForAgent(7, 901, [
      {
        item_key: 'strategy-run-101',
        status: 'ready',
        verdict: '表现较强',
        summary: '收益和回撤平衡较好。',
      },
    ]);

    expect(payload).toEqual(expect.objectContaining({
      ownerUserId: 7,
      runGroupId: 901,
      ai_interpretation_status: 'completed',
    }));
    expect(persistStrategyRunGroupInterpretationsFromAgent).toHaveBeenCalledWith({
      ownerUserId: 7,
      runGroupId: 901,
      items: [
        {
          item_key: 'strategy-run-101',
          status: 'ready',
          verdict: '表现较强',
          summary: '收益和回撤平衡较好。',
        },
      ],
    });
  });

  it('mirrors agent analysis results into analysis history rows', async () => {
    const create = jest.fn(async ({ data }) => data);
    const findFirst = jest.fn(async () => null);
    const newsFindUnique = jest.fn(async () => null);
    const newsCreate = jest.fn(async ({ data }) => data);
    const newsUpdate = jest.fn(async ({ data }) => data);
    const service = new AgentChatService(
      {} as any,
      {
        analysisHistory: {
          findFirst,
          create,
        },
        newsIntel: {
          findUnique: newsFindUnique,
          create: newsCreate,
          update: newsUpdate,
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.saveAnalysisHistoryFromAgent(
      7,
      'session-123',
      11,
      {
        run_id: 'run-chat-1',
        trade_date: '2026-04-04',
        portfolio_summary: {
          candidate_order_count: 2,
        },
        stocks: [
          {
            code: '600519',
            name: '贵州茅台',
            operation_advice: '买入',
            sentiment_score: 88,
            trend_signal: 'BUY',
            stop_loss: 1590,
            take_profit: 1760,
            candidate_order: {
              code: '600519',
            },
            raw: {
              data: {
                analysis_context: {
                  stock_name: '贵州茅台',
                },
                realtime_quote: {
                  price: 1680,
                  change_pct: 1.8,
                },
              },
              signal: {
                operation_advice: '买入',
                sentiment_score: 88,
                trend_signal: 'BUY',
                ai_payload: {
                  analysis_summary: '基本面与趋势共振，适合跟踪买入。',
                  news_summary: '白酒需求稳健，短线情绪偏多。',
                  news_items: [
                    {
                      title: '贵州茅台发布新品',
                      snippet: '公司发布新品并强调渠道稳定。',
                      url: 'https://example.com/news-1',
                      source: 'example.com',
                      published_date: '2026-04-03T09:30:00+08:00',
                      provider: 'mock_search',
                      dimension: 'news',
                      query: '贵州茅台 最新新闻',
                    },
                    {
                      title: '贵州茅台披露分红方案',
                      snippet: '公司公告年度分红预案。',
                      url: 'https://example.com/news-2',
                      source: 'cninfo.com.cn',
                      published_date: '2026-04-02',
                      provider: 'mock_search',
                      dimension: 'announcement',
                      query: '贵州茅台 公告',
                    },
                  ],
                  sniper_points: {
                    ideal_buy: 1660,
                    secondary_buy: 1635,
                  },
                },
              },
              risk: {
                effective_stop_loss: 1590,
                effective_take_profit: 1760,
              },
              execution: {
                action: 'buy',
                proposal_state: 'proposed',
              },
            },
          },
          {
            code: '000001',
            name: '平安银行',
            operation_advice: '观望',
            sentiment_score: 55,
            trend_signal: 'HOLD',
            raw: {
              data: {
                analysis_context: {
                  stock_name: '平安银行',
                },
                realtime_quote: {
                  price: 12.36,
                  change_pct: 0.66,
                },
              },
              signal: {
                operation_advice: '观望',
                sentiment_score: 55,
                trend_signal: 'HOLD',
                ai_payload: {},
              },
              risk: {
                effective_stop_loss: 11.8,
                effective_take_profit: 13.5,
              },
              execution: {
                action: 'hold',
                proposal_state: 'blocked',
              },
            },
          },
        ],
      },
    );

    expect(result).toEqual(expect.objectContaining({
      saved_count: 2,
      skipped_count: 0,
    }));
    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        ownerUserId: 7,
        queryId: 'agc_session-123_11_600519',
      },
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        ownerUserId: 7,
        queryId: 'agc_session-123_11_600519',
        code: '600519',
        name: '贵州茅台',
        recordSource: 'agent_chat',
        reportType: 'detailed',
        operationAdvice: '买入',
        sentimentScore: 88,
        trendPrediction: '看多',
        analysisSummary: '基本面与趋势共振，适合跟踪买入。',
        newsContent: '白酒需求稳健，短线情绪偏多。',
        idealBuy: 1660,
        secondaryBuy: 1635,
        stopLoss: 1590,
        takeProfit: 1760,
      }),
    }));

    const firstPayload = create.mock.calls[0][0].data;
    expect(JSON.parse(firstPayload.rawResult)).toEqual(expect.objectContaining({
      data_snapshot: expect.objectContaining({
        analysis_context: expect.any(Object),
      }),
      signal_snapshot: expect.objectContaining({
        ai_payload: expect.any(Object),
      }),
      risk_snapshot: expect.objectContaining({
        effective_stop_loss: 1590,
      }),
      execution_snapshot: expect.objectContaining({
        action: 'buy',
      }),
    }));
    expect(JSON.parse(firstPayload.contextSnapshot)).toEqual(expect.objectContaining({
      realtime_quote_raw: expect.objectContaining({
        price: 1680,
      }),
      agent_chat: expect.objectContaining({
        session_id: 'session-123',
        assistant_message_id: 11,
        candidate_order_count: 2,
      }),
    }));
    expect(newsFindUnique).toHaveBeenCalledTimes(2);
    expect(newsCreate).toHaveBeenCalledTimes(2);
    expect(newsCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ownerUserId: 7,
        queryId: 'agc_session-123_11_600519',
        code: '600519',
        title: '贵州茅台发布新品',
        url: 'https://example.com/news-1',
        provider: 'mock_search',
        dimension: 'news',
        requesterPlatform: 'agent_chat',
        requesterUserId: '7',
        requesterChatId: 'session-123',
        requesterMessageId: '11',
      }),
    });
    expect(newsUpdate).not.toHaveBeenCalled();
  });

  it('blocks agent simulated orders outside trading session and preserves audit payload', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-05T02:00:00.000Z'));
    const previousEnforce = process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION;
    const previousTimezone = process.env.ANALYSIS_AUTO_ORDER_TIMEZONE;
    const previousSessions = process.env.ANALYSIS_AUTO_ORDER_TRADING_SESSIONS;
    process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION = 'true';
    process.env.ANALYSIS_AUTO_ORDER_TIMEZONE = 'Asia/Shanghai';
    process.env.ANALYSIS_AUTO_ORDER_TRADING_SESSIONS = '09:30-11:30,13:00-15:00';

    const create = jest.fn(async ({ data }) => data);
    const tradingAccountService = {
      placeOrder: jest.fn(async () => ({
        status: 'filled',
      })),
    };
    const service = new AgentChatService(
      {} as any,
      {
        agentExecutionEvent: {
          create,
        },
      } as any,
      {} as any,
      {
        getMySimulationAccountStatus: jest.fn(async () => ({
          is_bound: true,
          is_verified: true,
          broker_account_id: 7,
        })),
      } as any,
      tradingAccountService as any,
    );

    try {
      const result = await service.placeSimulatedOrderForAgent(7, 'session-1', {
        code: '600519',
        action: 'buy',
        quantity: 100,
        price: 1680,
      });

      expect(result).toEqual(expect.objectContaining({
        status: 'blocked',
        reason: 'outside_trading_session',
        message: expect.stringContaining('非交易时段'),
        session_guard: expect.objectContaining({
          timezone: 'Asia/Shanghai',
          sessions: ['09:30-11:30', '13:00-15:00'],
          next_open_at: '2026-04-06T01:30:00.000Z',
        }),
      }));
      expect(tradingAccountService.placeOrder).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          taskId: 'session-1',
          status: 'blocked',
          eventType: 'place_simulated_order',
        }),
      });
      expect(create.mock.calls[0][0].data.payloadJson).toContain('outside_trading_session');
    } finally {
      jest.useRealTimers();
      if (previousEnforce == null) {
        delete process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION;
      } else {
        process.env.ANALYSIS_AUTO_ORDER_ENFORCE_SESSION = previousEnforce;
      }
      if (previousTimezone == null) {
        delete process.env.ANALYSIS_AUTO_ORDER_TIMEZONE;
      } else {
        process.env.ANALYSIS_AUTO_ORDER_TIMEZONE = previousTimezone;
      }
      if (previousSessions == null) {
        delete process.env.ANALYSIS_AUTO_ORDER_TRADING_SESSIONS;
      } else {
        process.env.ANALYSIS_AUTO_ORDER_TRADING_SESSIONS = previousSessions;
      }
    }
  });

  it('skips agent analysis history rows that already exist for the same owner/query id', async () => {
    const create = jest.fn(async ({ data }) => data);
    const findFirst = jest.fn(async () => ({
      id: 9,
      queryId: 'agc_session-123_11_600519',
      newsContent: null,
    }));
    const newsFindUnique = jest.fn(async () => ({
      id: 31,
      ownerUserId: null,
      queryId: null,
      code: '',
      name: null,
      dimension: null,
      query: null,
      provider: null,
      title: '旧新闻',
      snippet: null,
      source: null,
      publishedDate: null,
      querySource: null,
      requesterPlatform: null,
      requesterUserId: null,
      requesterChatId: null,
      requesterMessageId: null,
      requesterQuery: null,
    }));
    const newsCreate = jest.fn(async ({ data }) => data);
    const newsUpdate = jest.fn(async ({ data }) => data);
    const service = new AgentChatService(
      {} as any,
      {
        analysisHistory: {
          findFirst,
          create,
        },
        newsIntel: {
          findUnique: newsFindUnique,
          create: newsCreate,
          update: newsUpdate,
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const result = await service.saveAnalysisHistoryFromAgent(
      7,
      'session-123',
      11,
      {
        stocks: [
          {
            code: '600519',
            name: '贵州茅台',
            operation_advice: '买入',
            sentiment_score: 88,
            trend_signal: 'BUY',
            raw: {
              data: {},
              signal: {
                ai_payload: {
                  news_items: [
                    {
                      title: '贵州茅台发布新品',
                      snippet: '公司发布新品并强调渠道稳定。',
                      url: 'https://example.com/news-1',
                      source: 'example.com',
                      published_date: '2026-04-03T09:30:00+08:00',
                      provider: 'mock_search',
                      dimension: 'news',
                      query: '贵州茅台 最新新闻',
                    },
                  ],
                },
              },
              risk: {},
              execution: {},
            },
          },
        ],
      },
    );

    expect(result).toEqual({
      saved_count: 0,
      skipped_count: 1,
      items: [
        {
          query_id: 'agc_session-123_11_600519',
          stock_code: '600519',
          stock_name: '贵州茅台',
          status: 'skipped_existing',
          news_saved_count: 1,
        },
      ],
    });
    expect(create).not.toHaveBeenCalled();
    expect(newsCreate).not.toHaveBeenCalled();
    expect(newsUpdate).toHaveBeenCalledWith({
      where: {
        url: 'https://example.com/news-1',
      },
      data: expect.objectContaining({
        ownerUserId: 7,
        queryId: 'agc_session-123_11_600519',
        code: '600519',
        name: '贵州茅台',
        dimension: 'news',
        query: '贵州茅台 最新新闻',
        provider: 'mock_search',
        snippet: '公司发布新品并强调渠道稳定。',
        source: 'example.com',
        querySource: 'agent_chat',
        requesterPlatform: 'agent_chat',
        requesterUserId: '7',
        requesterChatId: 'session-123',
        requesterMessageId: '11',
        requesterQuery: '贵州茅台 最新新闻',
      }),
    });
  });
});
