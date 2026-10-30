#!/usr/bin/env node
/* GitHub Actions updater for the live XAUUSD board.
 * Runs server-side (no CORS): pulls FRED macro + TradingView calendar,
 * writes data.json next to the page. The browser page reads data.json
 * from the same origin. Logic mirrors ~/workspace/gold-board/fetch_*.js. */
import fs from 'node:fs';

async function fetchText(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'gold-board/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(t); }
}

/* Parse a FRED fredgraph CSV -> last two valid observations. */
function parseFred(csv) {
  const rows = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const [date, raw] = line.split(',');
    const value = parseFloat(raw);
    if (date && isFinite(value)) rows.push({ date, value });
  }
  if (!rows.length) throw new Error('no valid rows');
  const last = rows[rows.length - 1];
  const prev = rows.length > 1 ? rows[rows.length - 2] : null;
  return {
    value: Math.round(last.value * 10000) / 10000,
    date: last.date,
    prev_value: prev ? Math.round(prev.value * 10000) / 10000 : null,
    prev_date: prev ? prev.date : null,
    change: prev ? Math.round((last.value - prev.value) * 10000) / 10000 : null,
  };
}

async function fetchFredSeries(id) {
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`);
  return parseFred(csv);
}

/*
 * Short-term verdict rule (points per series, from the day-over-day change):
 *   USD broad:  up >= +0.05  -> -1 (headwind) | down <= -0.05 -> +1 (tailwind)
 *   10Y yield:  up >= +0.03pp -> -1          | down <= -0.03pp -> +1
 *   Real yield: same thresholds as the nominal yield.
 *   Flat / inside the dead-band -> 0. Missing series -> skipped.
 * Total <= -2 -> "ĐÈ GIÁ" | >= +2 -> "ĐỠ GIÁ" | otherwise "TRUNG TÍNH".
 * (Gold-negative = USD/yields rising: higher opportunity cost, pricier gold
 * for non-USD buyers.)
 */
function scoreSeries(kind, change) {
  if (change == null) return 0;
  const band = kind === 'usd' ? 0.05 : 0.03;
  if (change >= band) return -1;
  if (change <= -band) return 1;
  return 0;
}

function loadStatic() {
  try {
    const j = JSON.parse(fs.readFileSync(STATIC, 'utf8'));
    return j.long_term || null;
  } catch (e) {
    console.error('[macro] static file unreadable:', e.message);
    return null;
  }
}

async function buildShort() {
  const [usd, us10y, real10y] = await Promise.allSettled([
    fetchFredSeries('DTWEXBGS'),
    fetchFredSeries('DGS10'),
    fetchFredSeries('DFII10'),
  ]);
  const got = (r) => (r.status === 'fulfilled' ? r.value : null);
  const errs = [usd, us10y, real10y]
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason.message);
  if (errs.length) console.error('[macro] series failed:', errs.join('; '));

  const u = got(usd), y = got(us10y), ry = got(real10y);
  if (!u && !y && !ry) throw new Error('all FRED series failed: ' + errs.join('; '));

  const points =
    scoreSeries('usd', u && u.change) +
    scoreSeries('yield', y && y.change) +
    scoreSeries('yield', ry && ry.change);
  const verdict = points <= -2 ? 'ĐÈ GIÁ' : points >= 2 ? 'ĐỠ GIÁ' : 'TRUNG TÍNH';

  return {
    verdict,
    points,
    usd: u ? { label: 'USD broad', value: u.value, change: u.change, date: u.date, source: 'FRED DTWEXBGS' } : null,
    us10y: y ? { label: 'Lợi suất Mỹ 10Y', value: y.value, change: y.change, unit: '%', date: y.date, source: 'FRED DGS10' } : null,
    real10y: ry ? { label: 'Lợi suất thực 10Y', value: ry.value, change: ry.change, unit: '%', date: ry.date, source: 'FRED DFII10' } : null,
  };
}


const MACRO_LT = {"central_bank_net_buy_tonnes": 289, "central_bank_period": "Q2/2026", "central_bank_yoy_pct": 62, "etf_flow_tonnes": -44.8, "etf_period": "Q2/2026", "headline": "NHTW gom vàng", "source": "World Gold Council", "source_note": "Số quý do WGC công bố, Gol kiểm chứng qua tìm kiếm ngày 28/10/2026. Cập nhật tay khi WGC ra kỳ mới.", "updated": "2026-10-28", "verdict": "ĐỠ GIÁ"};
async function buildMacro() {
  const base = { long_term: MACRO_LT, sources: 'USD/lợi suất: FRED · Dài hạn: World Gold Council' };
  try {
    const short = await buildShort();
    return { ...base, ok: true, stale: false, fetched_at: new Date().toISOString(), short_term: short };
  } catch (e) {
    console.error('[macro] failed:', e.message);
    return { ...base, ok: false, stale: false, fetched_at: new Date().toISOString(),
      short_term: { verdict: 'CHƯA CẬP NHẬT', points: null, usd: null, us10y: null, real10y: null } };
  }
}

function vnTitle(e) {
  const t = e.title || '';
  const c = e.country || '';
  const fed = /^Fed (.+?) Speech$/i.exec(t);
  if (fed) return `Fed — ${fed[1]} phát biểu`;
  const map = [
    [/Employment Cost Index/i, 'Chỉ số chi phí lao động Mỹ (ECI)'],
    [/Chicago PMI/i, 'PMI Chicago (Mỹ)'],
    [/Nonfarm Payrolls|Non-Farm/i, 'Bảng lương phi nông nghiệp (NFP)'],
    [/Unemployment Rate/i, c === 'EU' ? 'Tỷ lệ thất nghiệp EU' : 'Tỷ lệ thất nghiệp Mỹ'],
    [/GDP Growth Rate YoY/i, c === 'EU' ? 'GDP EU sơ bộ (năm)' : 'GDP Mỹ sơ bộ (năm)'],
    [/GDP Growth Rate QoQ Flash|GDP.*Flash/i, c === 'EU' ? 'GDP EU sơ bộ (quý)' : 'GDP Mỹ sơ bộ (quý)'],
    [/GDP Growth Rate/i, c === 'EU' ? 'GDP EU (quý)' : 'GDP Mỹ (quý)'],
    [/Core PCE Price Index/i, 'PCE lõi của Mỹ'],
    [/PCE Price Index/i, 'PCE của Mỹ'],
    [/Core CPI|CPI/i, c === 'EU' ? 'Lạm phát CPI EU' : 'Lạm phát CPI Mỹ'],
    [/Interest Rate Decision/i, c === 'JP' ? 'BOJ — quyết định lãi suất' : c === 'EU' ? 'ECB — quyết định lãi suất' : 'Fed — quyết định lãi suất'],
    [/FOMC|Fed.*Statement|Monetary Policy Statement/i, 'Fed — tuyên bố chính sách'],
    [/Powell/i, 'Fed — Powell phát biểu'],
    [/Lagarde/i, 'ECB — Lagarde phát biểu'],
    [/Ueda/i, 'BOJ — Ueda phát biểu'],
    [/ISM Manufacturing PMI/i, 'PMI sản xuất ISM (Mỹ)'],
    [/ISM Services PMI/i, 'PMI dịch vụ ISM (Mỹ)'],
    [/Retail Sales/i, 'Doanh số bán lẻ Mỹ'],
    [/Initial Jobless Claims/i, 'Đơn trợ cấp thất nghiệp Mỹ'],
    [/JOLTS Job Openings/i, 'Việc làm mở JOLTS (Mỹ)'],
    [/Consumer Confidence/i, 'Niềm tin tiêu dùng Mỹ'],
    [/Durable Goods/i, 'Đơn hàng bền Mỹ'],
    [/Speech/i, 'Phát biểu ngân hàng trung ương'],
  ];
  for (const [re, vn] of map) if (re.test(t)) return vn;
  return t.length > 42 ? t.slice(0, 41) + '…' : t;
}

function fmtTimeJst(iso) {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
    day: '2-digit', month: '2-digit',
  });
  const parts = f.formatToParts(d);
  const g = (ty) => parts.find((x) => x.type === ty).value;
  return { hm: `${g('hour')}:${g('minute')}`, dm: `${g('day')}/${g('month')}` };
}

function selectEvents(events, now) {
  const from = now.getTime() - 30 * 60000;
  const to = now.getTime() + 16 * 3600000;
  const todayJst = fmtTimeJst(now.toISOString()).dm;
  return (events || [])
    .filter((e) => {
      const ts = new Date(e.date).getTime();
      if (!(ts >= from && ts <= to)) return false;
      if (e.country === 'US' || e.country === 'EU') return (e.importance ?? 0) >= 0;
      if (e.country === 'JP') return (e.importance ?? 0) >= 1;
      return false;
    })
    /* drop sub-components (keep the headline index per timestamp) */
    .filter((e) => !/ - (Benefits|Wages|Salaries)/i.test(e.title || ''))
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    /* at most 2 events per release timestamp, so one data dump cannot
     * crowd out the rest of the evening */
    .filter(((seen) => (e) => {
      const n = (seen.get(e.date) || 0) + 1;
      seen.set(e.date, n);
      return n <= 2;
    })(new Map()))
    .map((e) => {
      const { hm, dm } = fmtTimeJst(e.date);
      return {
        time_jst: dm === todayJst ? hm : `${hm} ${dm}`,
        title: vnTitle(e),
        impact: (e.importance ?? 0) >= 1 ? 'high' : 'medium',
        forecast: e.forecast || null,
      };
    })
    /* dedupe identical time+title (YoY/QoQ variants can collapse) */
    .filter((it, i, arr) => arr.findIndex((x) => x.time_jst === it.time_jst && x.title === it.title) === i)
    .slice(0, 4);
}


async function fetchJson2(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Origin: 'https://www.tradingview.com' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(t); }
}
async function buildNews(now = new Date()) {
  try {
    const from = new Date(now.getTime() - 3600000).toISOString();
    const to = new Date(now.getTime() + 18 * 3600000).toISOString();
    const url = 'https://economic-calendar.tradingview.com/events?from=' +
      encodeURIComponent(from) + '&to=' + encodeURIComponent(to) +
      '&countries=' + encodeURIComponent('US,EU,JP') + '&minImportance=-1';
    const j = await fetchJson2(url);
    if (!j || j.status !== 'ok' || !Array.isArray(j.result)) throw new Error('bad calendar payload');
    return { ok: true, stale: false, fetched_at: now.toISOString(), items: selectEvents(j.result, now) };
  } catch (e) {
    console.error('[news] failed:', e.message);
    return { ok: false, stale: false, fetched_at: now.toISOString(), items: [] };
  }
}

(async () => {
  const [macro, news] = await Promise.all([buildMacro(), buildNews()]);
  const out = { updated_at: new Date().toISOString(), macro, news };
  fs.writeFileSync('data.json', JSON.stringify(out, null, 1));
  console.log('data.json written; macro ok=' + macro.ok + ' verdict=' +
    (macro.short_term && macro.short_term.verdict) + '; news items=' + news.items.length);
})();
