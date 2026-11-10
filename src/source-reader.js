import { lookup } from 'node:dns';
import { get } from 'node:https';
import { BlockList, isIP } from 'node:net';

const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]) privateAddresses.addSubnet(address, prefix);

export const isPublicSourceAddress = (address) => isIP(address) === 4 && !privateAddresses.check(address);

function publicLookup(host, options, callback) {
  lookup(host, { family: 4 }, (error, address, family) => {
    if (error) return callback(error);
    if (!isPublicSourceAddress(address)) return callback(new Error('Недоступный адрес источника'));
    if (options.all) return callback(null, [{ address, family }]);
    return callback(null, address, family);
  });
}

function getPublicHtml(url, signal) {
  return new Promise((resolve, reject) => {
    const request = get(url, { lookup: publicLookup, family: 4, agent: false, signal }, (response) => {
      if (response.statusCode !== 200 || !/^(?:text\/html|application\/xhtml\+xml|text\/plain)\b/i.test(response.headers['content-type'] || '')) {
        response.destroy();
        reject(new Error('Источник не отдал открытый текст страницы'));
        return;
      }
      response.setEncoding('utf8');
      let html = '';
      response.on('data', (chunk) => {
        html += chunk;
        if (html.length >= 300_000) {
          resolve(html.slice(0, 300_000));
          response.destroy();
        }
      });
      response.on('end', () => resolve(html));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

const attribute = (tag, name) => tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i'))?.slice(1).find((value) => value !== undefined);
const plain = (html) => html
  .replace(/<(script|style|noscript|template|svg)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
  .replace(/<[^<>]+>/g, ' ')
  .replace(/&(?:nbsp|amp|quot|apos|lt|gt|#39|#160);/gi, (value) => ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&lt;': '<', '&gt;': '>' })[value.toLowerCase()] || ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function sourceExcerpt(html) {
  const meta = (html.match(/<meta\b[^<>]*>/gi) || []).find((tag) =>
    /^(?:article:published_time|datepublished|publish_date)$/i.test(attribute(tag, 'property') || attribute(tag, 'name') || attribute(tag, 'itemprop') || ''),
  );
  const date = (meta && attribute(meta, 'content')) || html.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1];
  const publishedAt = /^\d{4}-\d{2}-\d{2}/.test(date || '') && Number.isFinite(Date.parse(date)) ? date.slice(0, 40) : undefined;
  const article = html.match(/<(article|main)\b[^<>]*>([\s\S]*)/i)?.[2] || html.match(/<body\b[^<>]*>([\s\S]*)/i)?.[1] || html;
  return { publishedAt, excerpt: plain(article.slice(0, 120_000)).slice(0, 4000) };
}

export async function readPublicSource(address, signal) {
  const url = URL.parse(address);
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.hostname.startsWith('[')
    || !url.hostname.includes('.') || isIP(url.hostname) || /\.(?:local|localhost|internal|test|example|invalid)$/i.test(url.hostname)) {
    throw new Error('Доступны только публичные страницы HTTPS');
  }
  try {
    const timeout = AbortSignal.timeout(7500);
    const html = await getPublicHtml(url, signal ? AbortSignal.any([signal, timeout]) : timeout);
    const data = sourceExcerpt(html);
    if (!data.excerpt) throw new Error('Страница не содержит читаемого текста');
    return data;
  } catch {
    throw new Error('Не удалось прочитать страницу. Доступна только выдержка из поиска.');
  }
}

export async function verifyNewsDates(sources, inWindow, { signal, read = readPublicSource } = {}) {
  const candidates = new Map();
  for (const source of [...sources].sort((left, right) => left.rank - right.rank)) {
    const url = URL.parse(source.url);
    if (source.publishedAt || url?.protocol !== 'https:' || candidates.has(url.hostname)) continue;
    candidates.set(url.hostname, source);
    if (candidates.size === 8) break;
  }
  const checks = await Promise.allSettled(Array.from(candidates.values(), async (source) => ({
    url: source.url,
    title: source.title,
    ...(await read(source.url, signal)),
  })));
  return checks.filter((check) => check.status === 'fulfilled' && inWindow(check.value)).map((check) => check.value);
}
