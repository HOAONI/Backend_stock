/** AgentChatController HTTP 层测试，覆盖会话列表、SSE 转发与上游错误映射。 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NextFunction, Request, Response as ExpressResponse } from 'express';
import request from 'supertest';

import { AgentChatController } from '../src/modules/agent-chat/agent-chat.controller';
import { AgentChatService } from '../src/modules/agent-chat/agent-chat.service';

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

describe('AgentChatController (e2e)', () => {
  let app: INestApplication;
  let agentChatService: {
    chat: jest.Mock;
    openChatStream: jest.Mock;
    listSessions: jest.Mock;
    getSession: jest.Mock;
    deleteSession: jest.Mock;
    getMonitorSnapshot: jest.Mock;
    openMonitorStream: jest.Mock;
  };

  beforeEach(async () => {
    agentChatService = {
      chat: jest.fn(),
      openChatStream: jest.fn(),
      listSessions: jest.fn(),
      getSession: jest.fn(),
      deleteSession: jest.fn(),
      getMonitorSnapshot: jest.fn(),
      openMonitorStream: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AgentChatController],
      providers: [
        {
          provide: AgentChatService,
          useValue: agentChatService,
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: ExpressResponse, next: NextFunction) => {
      req.authUser = {
        id: 7,
        username: 'tester',
        displayName: 'Tester',
        roleCodes: ['user'],
        permissions: {
          analysis: {
            canRead: true,
            canWrite: true,
          },
        },
      };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists chat sessions for current user', async () => {
    agentChatService.listSessions.mockResolvedValueOnce({
      total: 1,
      items: [
        {
          session_id: 'session-1',
          title: '600519 问股',
          latest_message_preview: '分析完成',
          message_count: 2,
        },
      ],
    });

    await request(app.getHttpServer())
      .get('/api/v1/agent/chat/sessions?limit=5')
      .expect(200)
      .expect(({ body }) => {
        expect(body.total).toBe(1);
        expect(body.items[0]).toMatchObject({
          session_id: 'session-1',
          title: '600519 问股',
        });
      });

    expect(agentChatService.listSessions).toHaveBeenCalledWith(7, 5);
  });

  it('streams SSE events from upstream agent chat', async () => {
    agentChatService.openChatStream.mockResolvedValueOnce(createSseResponse([
      'event: thinking\ndata: {"message":"正在理解你的问题"}\n\n',
      'event: done\ndata: {"session_id":"session-1","content":"分析完成","candidate_orders":[],"status":"analysis_only"}\n\n',
    ]));

    const response = await request(app.getHttpServer())
      .post('/api/v1/agent/chat/stream')
      .send({ message: '帮我分析一下 600519' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    expect(response.text).toContain('event: thinking');
    expect(response.text).toContain('event: done');
    expect(response.text).toContain('"session_id":"session-1"');
    expect(agentChatService.openChatStream).toHaveBeenCalledWith(7, 'tester', {
      message: '帮我分析一下 600519',
    });
  });

  it('maps upstream agent stream failures before headers are sent', async () => {
    agentChatService.openChatStream.mockRejectedValueOnce(Object.assign(new Error('Agent offline'), {
      code: 'UPSTREAM_ERROR',
      statusCode: 503,
    }));

    await request(app.getHttpServer())
      .post('/api/v1/agent/chat/stream')
      .send({ message: '帮我分析一下 600519' })
      .expect(503)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          error: 'upstream_error',
          message: 'Agent offline',
        });
      });
  });

  it('returns monitor snapshot for current user', async () => {
    agentChatService.getMonitorSnapshot.mockResolvedValueOnce({
      session: {
        session_id: 'monitor-session-1',
        title: '最近一次协作',
        live_status: 'completed',
      },
      agent_cards: [
        {
          code: 'data',
          title: '数据 Agent',
          status: 'completed',
          total_calls: 12,
        },
      ],
      execution_chain: [],
      stock_details: [],
    });

    await request(app.getHttpServer())
      .get('/api/v1/agent/chat/monitor')
      .expect(200)
      .expect(({ body }) => {
        expect(body.session).toMatchObject({
          session_id: 'monitor-session-1',
          title: '最近一次协作',
        });
        expect(body.agent_cards[0]).toMatchObject({
          code: 'data',
          total_calls: 12,
        });
      });

    expect(agentChatService.getMonitorSnapshot).toHaveBeenCalledWith(7);
  });

  it('streams monitor SSE snapshots from upstream agent service', async () => {
    agentChatService.openMonitorStream.mockResolvedValueOnce(createSseResponse([
      'event: connected\ndata: {"message":"Connected to agent chat monitor stream"}\n\n',
      'event: snapshot\ndata: {"session":{"session_id":"monitor-session-1","live_status":"running"},"agent_cards":[],"execution_chain":[],"stock_details":[]}\n\n',
    ]));

    const response = await request(app.getHttpServer())
      .get('/api/v1/agent/chat/monitor/stream')
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    expect(response.text).toContain('event: connected');
    expect(response.text).toContain('event: snapshot');
    expect(response.text).toContain('"session_id":"monitor-session-1"');
    expect(agentChatService.openMonitorStream).toHaveBeenCalledWith(7);
  });
});
