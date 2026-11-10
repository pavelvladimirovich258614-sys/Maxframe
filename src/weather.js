const CACHE_TTL_MS = 20 * 60 * 1000;
const CACHE_LIMIT = 50;
const YANDEX_API = 'https://api.weather.yandex.ru/graphql/query';
const GEOCODING_API = 'https://geocoding-api.open-meteo.com/v1/search';

async function requestJson(fetchImpl, url, service, { signal, ...options } = {}) {
  const timeout = AbortSignal.timeout(8000);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: 'error',
    });
  } catch {
    throw new Error(`${service}: не удалось подключиться или истекло время ожидания`);
  }
  if (!response.ok) throw new Error(`${service}: HTTP ${response.status}`);
  return response.json().catch(() => { throw new Error(`${service}: некорректный ответ`); });
}

const normalize = (value) => String(value ?? '').trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function yandexWeatherTool({ key, fetchImpl = fetch } = {}) {
  if (!key?.trim()) return null;
  const cache = new Map();
  return {
    name: 'get_weather',
    description: 'Получить текущую погоду и почасовой прогноз на ближайшие 48 часов из Яндекс Погоды. Для одноимённых городов укажи регион через запятую.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'Город или город, регион. Без частного адреса.' } },
      required: ['city'],
    },
    async handler({ city } = {}, { signal } = {}) {
      if (typeof city !== 'string' || city.trim().length < 2 || city.length > 100 || !/^[\p{L} .,'’()\-–]+$/u.test(city)) {
        throw new Error('Укажи название города и, при необходимости, регион через запятую');
      }
      const cacheKey = normalize(city);
      const cached = cache.get(cacheKey);
      if (cached?.until > Date.now()) return cached.value;

      const [name, ...regions] = city.split(',').map((part) => part.trim());
      const region = normalize(regions.join(', '));
      const geocodeUrl = new URL(GEOCODING_API);
      geocodeUrl.search = new URLSearchParams({ name, count: '15', language: 'ru' });
      const locations = await requestJson(fetchImpl, geocodeUrl, 'Поиск города', { signal });
      const place = (locations?.results ?? []).find((candidate) =>
        Number.isFinite(candidate.latitude) && Math.abs(candidate.latitude) <= 90
        && Number.isFinite(candidate.longitude) && Math.abs(candidate.longitude) <= 180
        && (!region || [candidate.admin1, candidate.admin2, candidate.country].some((part) => normalize(part).includes(region))));
      if (!place) throw new Error('Город не найден. Проверь написание или уточни регион');

      const query = `{ serverTime weatherByPoint(request: { lat: ${place.latitude}, lon: ${place.longitude} }) {
        now { temperature feelsLike windSpeed condition }
        forecast { days { time hours { time temperature condition } } }
      } }`;
      const result = await requestJson(fetchImpl, YANDEX_API, 'Яндекс Погода', {
        method: 'POST',
        signal,
        headers: { 'X-Yandex-Weather-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const weather = result?.data?.weatherByPoint;
      if (!Number.isFinite(weather?.now?.temperature)) throw new Error('Яндекс Погода не вернула текущую температуру');
      const value = JSON.stringify({
        source: 'Яндекс Погода',
        url: 'https://yandex.ru/pogoda/',
        city: place.name,
        region: place.admin1,
        timeZone: place.timezone,
        retrievedAt: result.data.serverTime,
        current: weather.now,
        forecast: (weather.forecast?.days ?? []).slice(0, 3).flatMap((day) => day.hours ?? []).slice(0, 48),
      });
      cache.delete(cacheKey);
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { until: Date.now() + CACHE_TTL_MS, value });
      return value;
    },
  };
}
