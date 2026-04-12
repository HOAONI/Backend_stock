import { mapAgentRunToAnalysis } from '../src/modules/analysis/analysis.mapper';

describe('mapAgentRunToAnalysis', () => {
  it('extracts news items, deduplicates urls, and hydrates newsContent', () => {
    const result = mapAgentRunToAnalysis({
      run_id: 'run-news-1',
      signal_snapshot: {
        '600519': {
          operation_advice: '买入',
          sentiment_score: 76,
          trend_signal: '看多',
          ai_payload: {
            analysis_summary: '茅台新闻和技术面共振偏多。',
            news_summary: '近期新闻整体偏多。',
            news_items: [
              {
                title: '贵州茅台发布新品',
                snippet: '公司发布新品并强调渠道稳定。',
                url: 'https://example.com/news-1',
                source: 'example.com',
                published_date: '2026-04-02T09:00:00+08:00',
                provider: 'mock_search',
                dimension: 'news',
                query: '贵州茅台 最新新闻',
              },
              {
                title: '重复新闻',
                snippet: '这条会被去重。',
                url: 'https://example.com/news-1',
              },
              {
                title: '贵州茅台披露分红方案',
                snippet: '公司公告年度分红预案。',
                url: 'https://example.com/news-2',
                source: 'cninfo.com.cn',
              },
            ],
          },
        },
      },
      data_snapshot: {
        '600519': {
          analysis_context: {
            name: '贵州茅台',
          },
          realtime_quote: {
            name: '贵州茅台',
            price: 1680,
            change_pct: 1.88,
          },
        },
      },
    }, '600519', 'detailed');

    expect(result.queryId).toBe('run-news-1');
    expect(result.newsItems).toEqual([
      expect.objectContaining({
        title: '贵州茅台发布新品',
        url: 'https://example.com/news-1',
        source: 'example.com',
        provider: 'mock_search',
        dimension: 'news',
        query: '贵州茅台 最新新闻',
      }),
      expect.objectContaining({
        title: '贵州茅台披露分红方案',
        url: 'https://example.com/news-2',
        source: 'cninfo.com.cn',
      }),
    ]);
    expect(result.report).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        news_content: '近期新闻整体偏多。',
      }),
    }));
    expect(result.historyRecord.newsContent).toBe('近期新闻整体偏多。');
  });
});
