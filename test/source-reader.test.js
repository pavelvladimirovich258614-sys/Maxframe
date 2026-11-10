import test from 'node:test';
import assert from 'node:assert/strict';
import { isPublicSourceAddress, readPublicSource, sourceExcerpt, verifyNewsDates } from '../src/source-reader.js';

test('source excerpts use publication metadata and ignore scripts', () => {
  const article = sourceExcerpt(`<head><meta content='2026-11-10T09:00:00+08:00' property="article:published_time"></head>
    <main><article><p>Данные &amp; детали</p><script>не выполнять</script></article></main>`);
  assert.equal(article.publishedAt, '2026-11-10T09:00:00+08:00');
  assert.equal(article.excerpt, 'Данные & детали');
  assert.equal(sourceExcerpt('<script>{"datePublished":"2026-11-09"}</script><p>Статья</p>').publishedAt, '2026-11-09');
  assert.equal(sourceExcerpt('<time datetime="2026-11-10"></time>').publishedAt, undefined);
});

test('news verification reads independent pages and keeps only dates inside the window', async () => {
  const called = [];
  const checked = await verifyNewsDates([
    { url: 'https://first.example/lower', rank: 2 },
    { url: 'https://second.example/old', rank: 0 },
    { url: 'https://first.example/current', rank: 0 },
    { url: 'https://third.example/known', rank: 0, publishedAt: '2026-11-10' },
  ], ({ publishedAt }) => ['2026-11-09', '2026-11-10'].includes(publishedAt), { read: async (url) => {
    called.push(url);
    return { publishedAt: url.endsWith('/current') ? '2026-11-10' : '2026-11-08', excerpt: 'Публикация' };
  } });
  assert.deepEqual(called, ['https://second.example/old', 'https://first.example/current']);
  assert.deepEqual(checked.map(({ url }) => url), ['https://first.example/current']);
});

test('source reader rejects local and special-use addresses', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '10.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isPublicSourceAddress(address), false, address);
  }
  assert.equal(isPublicSourceAddress('8.8.8.8'), true);
  for (const url of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://host.internal', 'https://user@example.com', 'https://example.com:8443']) {
    await assert.rejects(readPublicSource(url), /публичные страницы HTTPS/);
  }
});
