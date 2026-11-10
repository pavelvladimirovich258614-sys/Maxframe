import test from 'node:test';
import assert from 'node:assert/strict';
import { yandexWeatherTool } from '../src/weather.js';

const place = { name: 'Ангарск', latitude: 52.54, longitude: 103.89, admin1: 'Иркутская область', timezone: 'Asia/Irkutsk' };
const ok = (data) => ({ ok: true, json: async () => data });

test('weather resolves the region, uses the key only for Yandex, and caches weather', async () => {
  const calls = [];
  const tool = yandexWeatherTool({ key: 'test-weather-key', fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === 1) return ok({ results: [{ ...place, admin1: 'Другой регион' }, place] });
    return ok({ data: { serverTime: '2026-11-10T12:00:00Z', weatherByPoint: {
      now: { temperature: -5, feelsLike: -9, windSpeed: 4, condition: 'CLOUDY' },
      forecast: { days: [{ hours: [{ time: '2026-11-10T13:00:00Z', temperature: -6 }] }] },
    } } });
  } });
  const result = JSON.parse(await tool.handler({ city: 'Ангарск, Иркутская область' }));
  assert.equal(result.current.temperature, -5);
  assert.equal(result.forecast[0].temperature, -6);
  assert.equal(result.timeZone, 'Asia/Irkutsk');
  assert.equal(calls[0].url.searchParams.get('name'), 'Ангарск');
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].url.href, 'https://api.weather.yandex.ru/graphql/query');
  assert.equal(calls[1].options.headers['X-Yandex-Weather-Key'], 'test-weather-key');
  assert.match(JSON.parse(calls[1].options.body).query, /lat: 52\.54, lon: 103\.89/);
  assert.equal(calls[1].options.redirect, 'error');
  await tool.handler({ city: 'ангарск, иркутская область' });
  assert.equal(calls.length, 2);
});

test('weather reports upstream rejection and keeps credentials out of errors', async () => {
  let calls = 0;
  const tool = yandexWeatherTool({ key: 'test-weather-key', fetchImpl: async () =>
    ++calls % 2 ? ok({ results: [place] }) : { ok: false, status: 403 },
  });
  await assert.rejects(tool.handler({ city: 'Ангарск' }), { message: 'Яндекс Погода: HTTP 403' });
  await assert.rejects(tool.handler({ city: 'Ангарск' }), /403/);
  assert.equal(calls, 4);
  await assert.rejects(tool.handler({ city: 'Ангарск, дом 25' }), /название города/);
  assert.equal(yandexWeatherTool({ key: '' }), null);
});
