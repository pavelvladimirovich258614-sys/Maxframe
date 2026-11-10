import test from 'node:test';
import assert from 'node:assert/strict';
import { webSearchTool } from '../src/web-search.js';

test('search requests SearXNG JSON and returns bounded source data', async () => {
  let requested;
  const tool = webSearchTool({ baseUrl: 'http://localhost:8080', fetchImpl: async (url) => {
    requested = url;
    return { ok: true, json: async () => ({ results: [
      { title: 'Invalid', url: 'file:///tmp/secret' },
      { title: 'Result', url: 'https://example.org/news', content: 'Excerpt', publishedDate: '2026-11-10' },
    ] }) };
  } });
  const result = JSON.parse(await tool.handler({ query: 'тест', category: 'news', period: 'day' }));
  assert.equal(requested.pathname, '/search');
  assert.equal(requested.searchParams.get('format'), 'json');
  assert.equal(requested.searchParams.get('q'), 'тест');
  assert.equal(requested.searchParams.get('categories'), 'news');
  assert.equal(requested.searchParams.get('time_range'), 'day');
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://example.org/news');
  assert.equal(result.results[0].publishedAt, '2026-11-10');
  assert.equal(tool.dangerous, true);
});

test('search reports disabled JSON API and rejects invalid queries', async () => {
  assert.equal(webSearchTool({ baseUrl: '' }), null);
  const tool = webSearchTool({ baseUrl: 'http://localhost:8080', fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(tool.handler({ query: 'x' }), /403/);
  await assert.rejects(tool.handler({ query: ' ' }), /запрос/);
});
