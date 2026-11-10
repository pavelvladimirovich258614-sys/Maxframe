// Pure parsers for bank and exchange mails (no database): BIDV card, Bybit transfers.
// Returns { at, amount, currency, merchant, note, category, source, direction, external_id } or null.
const CATS = [
  [/grab|gojek|be group|xanh sm|taxi|uber/i, 'транспорт и доставка'],
  [/coffee|cafe|caf[eé]|highlands|starbucks|phuc long|trung nguyen/i, 'кафе'],
  [/restaurant|food|pho|bbq|kfc|lotteria|pizza|burger|bakery|banh/i, 'еда'],
  [/circle k|7-eleven|gs25|family ?mart|winmart|bach hoa|co\.?op|lotte mart|aeon|go!|big c|mart/i, 'продукты и магазины'],
  [/apple|google|openai|anthropic|claude|chatgpt|figma|notion|github|vercel|render|cloudflare|beget|serverspace/i, 'сервисы и подписки'],
  [/pharma|thuoc|hospital|clinic|long chau|an khang/i, 'здоровье'],
  [/gym|fitness|yoga/i, 'спорт'],
];

export const categorize = (merchant = '') => CATS.find(([re]) => re.test(merchant))?.[1] || 'прочее';

const num = (s) => {
  const t = String(s).trim();
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  return Number(t.replace(',', '.'));
};
const utc = (s) => Date.parse(s.replace(' ', 'T') + 'Z');

export function parseBidv(from, text) {
  if (!/bidv/i.test(from || '') && !/NOTIFICATION OF TRANSACTION/i.test(text || '')) return null;
  const a = text.match(/Original amount:\s*([\d.,]+)\s*([A-Z]{3})/i) || text.match(/Số tiền[^:]*:\s*([\d.,]+)\s*([A-Z]{3})/i);
  if (!a) return null;
  // Declined payments (KHÔNG THÀNH CÔNG / UNSUCCESSFUL) are not spending.
  if (/KHÔNG THÀNH CÔNG|UNSUCCESSFUL|Unsuccess|Không thành công|declined|not sufficient/i.test(text)) return null;
  const t = text.match(/(?:Time|Vào lúc)[^:]*:\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):?(\d{2})?/i);
  const at = t ? Date.parse(`${t[3]}-${t[2]}-${t[1]}T${t[4]}:${t[5]}:${t[6] || '00'}+07:00`) : null;
  const merchant = (text.match(/(?:Tại\/At|At):\s*([^\n]+)/i)?.[1] || '').trim();
  const code = text.match(/Approval code:\s*(\w+)/i)?.[1];
  const refund = /hoàn|refund|reversal/i.test(text.match(/Transaction type:\s*([^\n]+)/i)?.[1] || '');
  return { at, amount: num(a[1]), currency: a[2].toUpperCase(), merchant, note: (text.match(/Transaction type:\s*([^\n]+)/i)?.[1] || '').trim(), source: 'BIDV', direction: refund ? 'in' : 'out', external_id: code ? `bidv:${code}:${at}` : null };
}

export function parseBybit(from, subject, text, fallbackAt = null) {
  if (!/bybit/i.test(`${from} ${subject}`)) return null;
  let m = text.match(/отправили\s+([\d.,]+)\s+([A-Z0-9]+)\s+пользователю Bybit\s+(\d+)/i);
  if (m) return { at: fallbackAt, amount: num(m[1]), currency: m[2], merchant: `Bybit → UID ${m[3]}`, category: 'переводы', note: 'Внутренний перевод отправлен', source: 'Bybit', direction: 'out' };
  m = text.match(/перевод от\s+([^\s]+?)\.?\s*\n[\s\S]*?Сумма перевода:\s*([\d.,]+)\s*([A-Z0-9]+)[\s\S]*?Время перевода:\s*([\d-]+ [\d:]+)/i);
  if (m) return { at: utc(m[4]), amount: num(m[2]), currency: m[3], merchant: `Bybit ← ${m[1]}`, category: 'поступления', note: 'Внутренний перевод получен', source: 'Bybit', direction: 'in' };
  m = text.match(/Сумма депозита[：:]\s*([\d.,]+)\s*([A-Z0-9]+)[\s\S]*?Время подтверждения[：:]\s*([\d-]+ [\d:]+)/i);
  if (m) return { at: utc(m[3]), amount: num(m[1]), currency: m[2], merchant: `Bybit депозит${(text.match(/Вид сети[：:]\s*([^\n]+)/i)?.[1] || '').trim() ? ` · ${(text.match(/Вид сети[：:]\s*([^\n]+)/i)[1]).trim()}` : ''}`, category: 'поступления', note: 'Депозит', source: 'Bybit', direction: 'in' };
  m = text.match(/(?:Сумма вывода|вывели|withdrawal amount)[：:\s]*([\d.,]+)\s*([A-Z0-9]+)/i);
  if (m) return { at: fallbackAt, amount: num(m[1]), currency: m[2], merchant: 'Bybit вывод', category: 'переводы', note: 'Вывод', source: 'Bybit', direction: 'out' };
  return null;
}

export function parseFinanceMail(from, subject, text, fallbackAt = null) {
  const r = parseBidv(from, text || '') || parseBybit(from, subject || '', text || '', fallbackAt);
  if (r && !r.at) r.at = fallbackAt || Date.now();
  // Same operation seen twice (mail folder and inbox) must get the same key: amount, who and day.
  if (r && !r.external_id) r.external_id = `${r.source.toLowerCase()}:${r.direction}:${r.amount}:${r.currency}:${r.merchant}:${new Date(r.at + 7 * 3600000).toISOString().slice(0, 10)}`;
  return r;
}
