// SearXNG is optional. A configured instance receives the search query.
export function webSearchTool({ baseUrl = process.env.SEARXNG_URL, fetchImpl = fetch } = {}) {
  if (!baseUrl?.trim()) return null;
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('SEARXNG_URL должен быть HTTP(S) адресом без учётных данных');
  }
  return {
    name: 'web_search',
    description: 'Искать публичные материалы в интернете через SearXNG. Для свежих новостей выбери news и подходящий период. Запрос передаётся поисковому сервису. Результаты являются выдержками, указывай ссылки на источники.',
    dangerous: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Поисковый запрос без личных данных' },
        category: { type: 'string', enum: ['general', 'news'] },
        period: { type: 'string', enum: ['day', 'month', 'year'] },
        language: { type: 'string', enum: ['ru-RU', 'en-US'] },
      },
      required: ['query'],
    },
    async handler({ query, category = 'general', period, language } = {}, { signal } = {}) {
      if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('Поисковый запрос должен содержать от 1 до 500 символов');
      if (!['general', 'news'].includes(category) || (period !== undefined && !['day', 'month', 'year'].includes(period))) {
        throw new Error('Неверная категория поиска или период');
      }
      if (language !== undefined && !['ru-RU', 'en-US'].includes(language)) throw new Error('Неверный язык поиска');
      const url = new URL('search', base.href.endsWith('/') ? base : `${base.href}/`);
      url.searchParams.set('q', query.trim());
      url.searchParams.set('format', 'json');
      if (category === 'news') url.searchParams.set('categories', 'news');
      if (language || category === 'news') url.searchParams.set('language', language ?? 'ru-RU');
      if (period) url.searchParams.set('time_range', period);
      let response;
      const timeout = AbortSignal.timeout(15000);
      try { response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' }); }
      catch (error) { throw new Error(`Поиск недоступен: ${error.name === 'TimeoutError' ? 'превышено время ожидания' : 'ошибка соединения'}`); }
      if (!response.ok) throw new Error(`Поиск недоступен: HTTP ${response.status}${response.status === 403 ? ' (проверьте доступность JSON API SearXNG)' : ''}`);
      const data = await response.json().catch(() => null);
      if (!Array.isArray(data?.results)) throw new Error('Поиск вернул ответ неизвестного формата');
      const results = [];
      for (const item of data.results) {
        if (typeof item?.url !== 'string' || item.url.length > 2048) continue;
        const link = URL.parse(item.url);
        if (!link || !['http:', 'https:'].includes(link.protocol) || link.username || link.password) continue;
        results.push({
          title: String(item.title || '').slice(0, 300),
          url: link.href,
          snippet: String(item.content || '').slice(0, 600),
          publishedAt: typeof item.publishedDate === 'string' ? item.publishedDate.slice(0, 40) : undefined,
        });
        if (results.length === 8) break;
      }
      return JSON.stringify({ query: query.trim(), category, results });
    },
  };
}
