'use strict';
/**
 * Zodam AI — servidor.
 * Busca cotações (Yahoo Finance, AwesomeAPI, CoinGecko, alternative.me), clima (Open-Meteo) e
 * notícias (RSS de jornais). A IA pode ser Gemini (grátis), Groq (grátis) ou Claude (pago).
 * Sem dependências: Node 18+. Funciona local (node server.js) e na Vercel (pasta /api).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

try {
  for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

const PORT = Number(process.env.PORT) || 3000;
const KEYS = {
  gemini: process.env.GEMINI_API_KEY || '',
  groq: process.env.GROQ_API_KEY || '',
  anthropic: process.env.ANTHROPIC_API_KEY || '',
};
const MODELS = {
  gemini: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  groq: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
};
const wanted = (process.env.AI_PROVIDER || '').toLowerCase();
// Ordem automática: opções gratuitas primeiro.
const PROVIDER = wanted && KEYS[wanted] ? wanted : KEYS.gemini ? 'gemini' : KEYS.groq ? 'groq' : KEYS.anthropic ? 'anthropic' : '';
const UA = 'Mozilla/5.0 (compatible; ZodamAI/1.0)';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const DEFAULT_CITY = process.env.DEFAULT_CITY || 'São Paulo';

// Voz do Zodam (ElevenLabs). Brian é uma voz padrão descrita como grave; troque por ELEVENLABS_VOICE_ID.
const ELEVEN = {
  key: process.env.ELEVENLABS_API_KEY || '',
  voice: process.env.ELEVENLABS_VOICE_ID || 'nPczCjzI2devNBz1zQrb',
  model: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
};

/* ---------- utilidades ---------- */
const cache = new Map();
async function cached(key, ttl, fn, force) {
  const c = cache.get(key);
  if (!force && c && Date.now() - c.t < ttl) return c.v;
  try {
    const v = await fn();
    if (!v || !v.noCache) cache.set(key, { t: Date.now(), v });
    return v;
  } catch (e) {
    if (c) return c.v;
    throw e;
  }
}
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + new URL(url).host);
  return r.json();
}
const pct = (a, b) => (b ? (a / b - 1) * 100 : null);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fx = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 10 ? 4 : 2 });
const sg = (n) => (n == null ? 'n/d' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%');

/* ---------- cotações ---------- */
function pack(series, dates, source) {
  series = series.slice(-130).map((v) => +Number(v).toFixed(4));
  dates = dates.slice(-130);
  const n = series.length;
  const price = series[n - 1];
  return { price, change: pct(price, series[n - 2]), change30d: n > 22 ? pct(price, series[n - 22]) : null, series, dates, source };
}
async function yahoo(sym, scale = 1) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('Yahoo sem dados para ' + sym);
  const cl = (r.indicators && r.indicators.quote && r.indicators.quote[0].close) || [];
  const ts = r.timestamp || [];
  const series = [], dates = [];
  cl.forEach((v, i) => {
    if (v != null) { series.push(v * scale); dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10)); }
  });
  if (series.length < 2) throw new Error('Série curta para ' + sym);
  const live = r.meta && r.meta.regularMarketPrice;
  if (live != null) series[series.length - 1] = live * scale;
  return pack(series, dates, 'Yahoo Finance');
}
async function awesome(pair) {
  const [d, l] = await Promise.all([
    getJSON(`https://economia.awesomeapi.com.br/json/daily/${pair}/130`),
    getJSON(`https://economia.awesomeapi.com.br/json/last/${pair}`),
  ]);
  const series = d.map((x) => parseFloat(x.bid)).reverse();
  const dates = d.map((x) => new Date(x.timestamp * 1000).toISOString().slice(0, 10)).reverse();
  const live = parseFloat(l[pair.replace('-', '')].bid);
  if (live) series[series.length - 1] = live;
  return pack(series, dates, 'AwesomeAPI');
}
async function coingecko(id) {
  const j = await getJSON(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=130&interval=daily`);
  return pack(j.prices.map((p) => p[1]), j.prices.map((p) => new Date(p[0]).toISOString().slice(0, 10)), 'CoinGecko');
}

const ASSETS = [
  { id: 'usdbrl', name: 'Dólar (USD/BRL)', short: 'DÓLAR', group: 'Câmbio', unit: 'R$', yf: 'BRL=X', fb: () => awesome('USD-BRL') },
  { id: 'eurbrl', name: 'Euro (EUR/BRL)', short: 'EURO', group: 'Câmbio', unit: 'R$', yf: 'EURBRL=X', fb: () => awesome('EUR-BRL') },
  { id: 'dxy', name: 'Índice Dólar (DXY)', short: 'DXY', group: 'Câmbio', unit: 'pts', yf: 'DX-Y.NYB' },
  { id: 'gold', name: 'Ouro', short: 'OURO', group: 'Commodities', unit: 'US$', yf: 'GC=F' },
  { id: 'silver', name: 'Prata', short: 'PRATA', group: 'Commodities', unit: 'US$', yf: 'SI=F' },
  { id: 'wti', name: 'Petróleo WTI', short: 'PETRÓLEO WTI', group: 'Commodities', unit: 'US$', yf: 'CL=F' },
  { id: 'brent', name: 'Petróleo Brent', short: 'BRENT', group: 'Commodities', unit: 'US$', yf: 'BZ=F' },
  { id: 'copper', name: 'Cobre', short: 'COBRE', group: 'Commodities', unit: 'US$', yf: 'HG=F' },
  { id: 'soy', name: 'Soja', short: 'SOJA', group: 'Commodities', unit: 'US$', yf: 'ZS=F', scale: 0.01 },
  { id: 'corn', name: 'Milho', short: 'MILHO', group: 'Commodities', unit: 'US$', yf: 'ZC=F', scale: 0.01 },
  { id: 'btc', name: 'Bitcoin', short: 'BITCOIN', group: 'Cripto', unit: 'US$', yf: 'BTC-USD', fb: () => coingecko('bitcoin') },
  { id: 'eth', name: 'Ethereum', short: 'ETHEREUM', group: 'Cripto', unit: 'US$', yf: 'ETH-USD', fb: () => coingecko('ethereum') },
  { id: 'ibov', name: 'Ibovespa', short: 'IBOVESPA', group: 'Bolsas e juros', unit: 'pts', yf: '^BVSP' },
  { id: 'spx', name: 'S&P 500', short: 'S&P 500', group: 'Bolsas e juros', unit: 'pts', yf: '^GSPC' },
  { id: 'ndx', name: 'Nasdaq', short: 'NASDAQ', group: 'Bolsas e juros', unit: 'pts', yf: '^IXIC' },
  { id: 'vix', name: 'VIX (volatilidade)', short: 'VIX', group: 'Bolsas e juros', unit: 'pts', yf: '^VIX' },
  { id: 'us10y', name: 'Juro EUA 10 anos', short: 'US10Y', group: 'Bolsas e juros', unit: '%', yf: '^TNX' },
];

async function fetchAsset(a) {
  const meta = { id: a.id, name: a.name, short: a.short, group: a.group, unit: a.unit };
  const errs = [];
  let r = null;
  try { r = await yahoo(a.yf, a.scale || 1); } catch (e) { errs.push(e.message); }
  if (!r && a.fb) { try { r = await a.fb(); } catch (e) { errs.push(e.message); } }
  return r ? { ...meta, ...r } : { ...meta, error: errs.join(' | ') };
}
async function getMarkets(force) {
  return cached('markets', 45e3, async () => {
    const [assets, fng] = await Promise.all([
      Promise.all(ASSETS.map(fetchAsset)),
      getJSON('https://api.alternative.me/fng/?limit=1')
        .then((j) => ({ value: +j.data[0].value, label: j.data[0].value_classification }))
        .catch(() => null),
    ]);
    const v = { updated: new Date().toISOString(), assets, fng };
    if (!assets.some((a) => a.price != null)) v.noCache = true;
    return v;
  }, force);
}

/* ---------- clima ---------- */
const CITIES = [
  ['São Paulo', -23.55, -46.63], ['Nova York', 40.71, -74.01], ['Londres', 51.51, -0.13],
  ['Tóquio', 35.68, 139.69], ['Pequim', 39.9, 116.41], ['Dubai', 25.2, 55.27],
];
const wxDesc = (c) => (c === 0 ? 'Céu limpo' : c <= 3 ? 'Parcialmente nublado' : c <= 48 ? 'Neblina' : c <= 67 ? 'Chuva' : c <= 77 ? 'Neve' : c <= 86 ? 'Pancadas' : 'Tempestade');
async function getWeather(force) {
  return cached('wx', 15 * 60e3, async () => {
    const j = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${CITIES.map((c) => c[1]).join(',')}&longitude=${CITIES.map((c) => c[2]).join(',')}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=1&timezone=auto`
    );
    const arr = Array.isArray(j) ? j : [j];
    const cities = arr.map((x, i) => ({
      name: CITIES[i][0], lat: CITIES[i][1], lng: CITIES[i][2],
      temp: x.current.temperature_2m, code: x.current.weather_code, wind: x.current.wind_speed_10m,
      max: x.daily && x.daily.temperature_2m_max ? x.daily.temperature_2m_max[0] : null,
      min: x.daily && x.daily.temperature_2m_min ? x.daily.temperature_2m_min[0] : null,
      rain: x.daily && x.daily.precipitation_probability_max ? x.daily.precipitation_probability_max[0] : null,
    }));
    return { updated: new Date().toISOString(), cities };
  }, force);
}

/* ---------- previsão de qualquer cidade (Open-Meteo, sem chave) ---------- */
const WEEK = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
async function cityForecast(name) {
  return cached('fc:' + name.toLowerCase(), 15 * 60e3, async () => {
    const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=pt&format=json`);
    const p = (g.results || [])[0];
    if (!p) throw new Error('cidade não encontrada: ' + name);
    const j = await getJSON(
      `https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&forecast_days=7&timezone=auto`
    );
    const d = j.daily;
    const days = d.time.map((t, i) => ({
      date: t, dow: WEEK[new Date(t + 'T12:00:00').getDay()], code: d.weather_code[i],
      max: d.temperature_2m_max[i], min: d.temperature_2m_min[i], rain: d.precipitation_probability_max[i], mm: d.precipitation_sum[i],
    }));
    return { place: [p.name, p.admin1, p.country].filter(Boolean).join(', '), now: j.current, days };
  });
}
const WX_Q = /(previs[aã]o|clima\b|chover|chuva|temperatura|vai fazer (calor|frio)|como est[aá] o tempo|tempo (hoje|amanh|agora|em |na |no |para ))/i;
function cityFrom(msg) {
  const m = msg.match(/\b(?:em|de|para|na|no|da|do)\s+([\p{L}'-]+(?:\s+(?:de|da|do|dos|das)?\s*[\p{L}'-]+){0,3})/iu);
  if (!m) return DEFAULT_CITY;
  const stop = /\b(hoje|amanh[aã]|agora|essa|esta|nesta|nessa|semana|fim|final|manh[aã]|tarde|noite|vai|ser[aá]|est[aá]|como|quanto|qual)\b/i;
  const c = m[1].split(stop)[0].trim().replace(/^(o|a|os|as)\s+/i, '');
  return c.length >= 3 ? c : DEFAULT_CITY;
}
async function forecastText(msg) {
  const f = await cityForecast(cityFrom(msg));
  const L = [`PREVISÃO DO TEMPO REAL (Open-Meteo) para ${f.place}:`,
    `- Agora: ${f.now.temperature_2m}°C (sensação ${f.now.apparent_temperature}°C), ${wxDesc(f.now.weather_code).toLowerCase()}, vento ${f.now.wind_speed_10m} km/h`];
  f.days.forEach((x) => L.push(`- ${x.dow} ${x.date.slice(5)}: ${wxDesc(x.code).toLowerCase()}, mín ${x.min}°C, máx ${x.max}°C, chance de chuva ${x.rain ?? 'n/d'}%, ${x.mm ?? 0} mm`));
  return L.join('\n');
}

/* ---------- busca na web (Tavily, plano grátis) ---------- */
async function webSearch(query) {
  if (!TAVILY_KEY) return '';
  const news = /not[ií]cia|hoje|agora|[úu]ltim|aconteceu|resultado|placar/i.test(query);
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + TAVILY_KEY },
    body: JSON.stringify({ query: query.slice(0, 380), max_results: 5, search_depth: 'basic', topic: news ? 'news' : 'general' }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('busca: ' + ((j.detail && j.detail.error) || r.status));
  const L = ['PESQUISA NA WEB (resultados de agora; cite a fonte pelo nome do site):'];
  (j.results || []).forEach((x) => L.push(`- [${new URL(x.url).hostname.replace(/^www\./, '')}] ${x.title}: ${String(x.content || '').replace(/\s+/g, ' ').slice(0, 450)}`));
  return L.length > 1 ? L.join('\n') : '';
}

/* ---------- riscos planetários: terremotos (USGS), clima espacial (NOAA), asteroides (NASA) ---------- */
const NASA_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';
async function getQuakes() {
  const j = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson');
  return (j.features || [])
    .filter((f) => f.properties && f.properties.mag != null)
    .map((f) => ({
      mag: f.properties.mag, place: f.properties.place || 'local desconhecido', time: f.properties.time,
      tsunami: !!f.properties.tsunami, alert: f.properties.alert || null, url: f.properties.url || null,
      lat: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[1] : null,
      lng: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[0] : null,
      depth: f.geometry && f.geometry.coordinates ? f.geometry.coordinates[2] : null,
    }))
    .sort((a, b) => b.mag - a.mag)
    .slice(0, 8);
}
const KP_TXT = (k) => (k >= 8 ? 'Tempestade geomagnética severa' : k >= 7 ? 'Tempestade geomagnética forte' : k >= 6 ? 'Tempestade geomagnética moderada' : k >= 5 ? 'Tempestade geomagnética leve' : k >= 4 ? 'Sol agitado' : 'Sol calmo');
async function getSpace() {
  const kpRaw = await getJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json');
  let rows = Array.isArray(kpRaw) ? kpRaw : [];
  if (rows.length && Array.isArray(rows[0])) rows = rows.slice(1).map((r) => ({ time_tag: r[0], Kp: r[1] })); // formato antigo (tabela)
  const last = rows.filter((r) => r && r.Kp != null && !isNaN(Number(r.Kp))).pop();
  if (!last) throw new Error('Kp indisponível');
  const kp = Number(last.Kp);
  const out = { kp, label: KP_TXT(kp), time: last.time_tag || null, scales: null };
  try { // escalas NOAA atuais: G (geomagnética), S (radiação solar), R (apagão de rádio)
    const sc = await getJSON('https://services.swpc.noaa.gov/products/noaa-scales.json');
    const now = sc && sc['0'];
    if (now) out.scales = { G: Number(now.G && now.G.Scale) || 0, S: Number(now.S && now.S.Scale) || 0, R: Number(now.R && now.R.Scale) || 0 };
  } catch {}
  return out;
}
async function getNeo() {
  const d0 = new Date(), d1 = new Date(Date.now() + 2 * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  const j = await getJSON(`https://api.nasa.gov/neo/rest/v1/feed?start_date=${iso(d0)}&end_date=${iso(d1)}&api_key=${encodeURIComponent(NASA_KEY)}`);
  const all = [];
  for (const day of Object.values(j.near_earth_objects || {})) {
    for (const o of day) {
      const c = (o.close_approach_data || [])[0];
      if (!c) continue;
      const dm = (o.estimated_diameter && o.estimated_diameter.meters) || {};
      all.push({
        name: String(o.name || '').replace(/[()]/g, '').trim(), hazardous: !!o.is_potentially_hazardous_asteroid,
        when: c.close_approach_date_full || c.close_approach_date,
        lunar: Number(c.miss_distance && c.miss_distance.lunar), km: Number(c.miss_distance && c.miss_distance.kilometers),
        kmh: Number(c.relative_velocity && c.relative_velocity.kilometers_per_hour),
        dmin: dm.estimated_diameter_min, dmax: dm.estimated_diameter_max, url: o.nasa_jpl_url || null,
      });
    }
  }
  return { count: all.length, closest: all.filter((x) => isFinite(x.lunar)).sort((a, b) => a.lunar - b.lunar).slice(0, 5) };
}
async function getHazards(force) {
  // Cada fonte falha sozinha: se uma cair, as outras continuam aparecendo.
  const [quakes, space, neo] = await Promise.all([
    cached('hz-q', 10 * 60e3, getQuakes, force).then((v) => ({ v })).catch((e) => ({ e: e.message })),
    cached('hz-s', 10 * 60e3, getSpace, force).then((v) => ({ v })).catch((e) => ({ e: e.message })),
    cached('hz-n', 6 * 3600e3, getNeo, force).then((v) => ({ v })).catch((e) => ({ e: e.message })),
  ]);
  return {
    updated: new Date().toISOString(),
    quakes: quakes.v || [], space: space.v || null, neo: neo.v || null,
    errors: { quakes: quakes.e || null, space: space.e || null, neo: neo.e || null },
  };
}
function hazardsText(h) {
  if (!h) return '';
  const L = ['RISCOS PLANETÁRIOS AGORA (USGS, NOAA, NASA):'];
  if (h.quakes && h.quakes.length) h.quakes.slice(0, 5).forEach((q) => L.push(`- Terremoto M${q.mag.toFixed(1)} em ${q.place}${q.tsunami ? ' (alerta de tsunami)' : ''}`));
  else L.push('- Terremotos M4.5+ nas últimas 24h: indisponível ou nenhum');
  if (h.space) L.push(`- Clima espacial: Kp ${h.space.kp} (${h.space.label.toLowerCase()})`);
  if (h.neo && h.neo.closest.length) h.neo.closest.slice(0, 3).forEach((a) => L.push(`- Asteroide ${a.name}: passa a ${a.lunar.toFixed(1)} distâncias da Lua em ${String(a.when).slice(0, 17)}${a.hazardous ? ' (classificado como potencialmente perigoso pela NASA)' : ''}`));
  return L.join('\n');
}

/* ---------- notícias ---------- */
const FEEDS = [
  ['BBC News', 'https://feeds.bbci.co.uk/news/world/rss.xml'],
  ['BBC Business', 'https://feeds.bbci.co.uk/news/business/rss.xml'],
  ['The New York Times', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
  ['NYT Business', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml'],
  ['The Guardian', 'https://www.theguardian.com/world/rss'],
  ['Guardian Business', 'https://www.theguardian.com/business/rss'],
  ['Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml'],
  ['DW', 'https://rss.dw.com/rdf/rss-en-all'],
  ['CNBC', 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114'],
  ['Folha de S.Paulo', 'https://feeds.folha.uol.com.br/mundo/rss091.xml'],
  ['G1 Economia', 'https://g1.globo.com/rss/g1/economia/'],
];
const clean = (s) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
const tagOf = (b, n) => {
  const m = b.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i'));
  return m ? m[1] : '';
};
const NEG = ['war', 'attack', 'strike', 'missile', 'sanction', 'crisis', 'recession', 'tariff', 'default', 'collapse', 'invasion', 'conflict', 'crash', 'plunge', 'tumble', 'shutdown', 'bankrupt', 'inflation', 'famine', 'terror', 'explosion', 'killed', 'threat', 'guerra', 'ataque', 'sanç', 'crise', 'recess', 'tarifa', 'calote', 'colapso', 'conflito', 'queda', 'inflação', 'míssil', 'bomba', 'ameaça'];
const POS = ['rally', 'growth', 'deal', 'ceasefire', 'record high', 'rate cut', 'recovery', 'surge', 'agreement', 'peace', 'boost', 'beats', 'acordo', 'crescimento', 'alta', 'cessar-fogo', 'recupera', 'avanço', 'paz', 'recorde'];
const TAGS = {
  'Petróleo': /\boil\b|crude|opec|petr[óo]leo|brent/,
  'Ouro': /\bgold\b|\bouro\b/,
  'Cripto': /bitcoin|crypto|cripto|ethereum/,
  'Dólar': /dollar|d[óo]lar|forex/,
  'China': /china|beijing|pequim|yuan/,
  'Juros/Fed': /federal reserve|\bfed\b|powell|interest rate|rate cut|juros|selic|copom/,
  'Brasil': /brazil|brasil|lula|ibovespa|petrobras/,
  'Geopolítica': /\bwar\b|ukraine|russia|gaza|israel|iran|ucr[âa]nia|guerra|nato|otan|sanction|sanç|middle east|oriente m[ée]dio/,
  'Tarifas': /tariff|trade war|tarifa/,
};
function toneOf(text) {
  const t = text.toLowerCase();
  const neg = NEG.filter((w) => t.includes(w)).length;
  const pos = POS.filter((w) => t.includes(w)).length;
  return { tone: neg > pos ? 'risco' : pos > neg ? 'positivo' : 'neutro', tags: Object.keys(TAGS).filter((k) => TAGS[k].test(t)) };
}
function imageOf(b) {
  const m =
    b.match(/<media:(?:thumbnail|content)[^>]*\burl="([^"]+)"/i) ||
    b.match(/<enclosure[^>]*\burl="([^"]+)"[^>]*type="image/i) ||
    b.match(/<enclosure[^>]*type="image[^"]*"[^>]*\burl="([^"]+)"/i) ||
    b.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m && /^https?:/.test(m[1]) ? m[1].replace(/&amp;/g, '&') : '';
}
function parseRSS(xml, source) {
  const items = [];
  const re = /<(item|entry)[\s>][\s\S]*?<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const title = clean(tagOf(b, 'title'));
    if (!title) continue;
    let link = clean(tagOf(b, 'link'));
    if (!link) { const h = b.match(/<link[^>]*href="([^"]+)"/); link = h ? h[1] : ''; }
    const desc = clean(tagOf(b, 'description') || tagOf(b, 'summary') || tagOf(b, 'content')).slice(0, 220);
    const when = Date.parse(clean(tagOf(b, 'pubDate') || tagOf(b, 'published') || tagOf(b, 'updated') || tagOf(b, 'dc:date'))) || 0;
    items.push({ source, title, link, desc, img: imageOf(b), ts: when, ...toneOf(title + ' ' + desc) });
  }
  return items;
}
async function getNews(force) {
  return cached('news', 10 * 60e3, async () => {
    const rs = await Promise.allSettled(
      FEEDS.map(async ([name, url]) => {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(12000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return parseRSS(await r.text(), name).slice(0, 8);
      })
    );
    const feeds = rs.map((r, i) => ({ source: FEEDS[i][0], ok: r.status === 'fulfilled' && r.value.length > 0, count: r.status === 'fulfilled' ? r.value.length : 0 }));
    const seen = new Set();
    const items = rs
      .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
      .sort((a, b) => b.ts - a.ts)
      .filter((i) => { const k = i.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 80);
    const v = { updated: new Date().toISOString(), items, feeds };
    if (!items.length) v.noCache = true;
    return v;
  }, force);
}

/* ---------- estatística / projeção ---------- */
function stats(series, look = 20) {
  const s = series.slice(-look), n = s.length;
  if (n < 5) return null;
  const mx = (n - 1) / 2, my = s.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  s.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  const t = series.slice(-31), rets = [];
  for (let i = 1; i < t.length; i++) rets.push(t[i] / t[i - 1] - 1);
  const mr = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mr) ** 2, 0) / Math.max(1, rets.length - 1));
  return { slope: num / den, sd };
}
function project(series, days) {
  const st = stats(series);
  if (!st) return null;
  const last = series[series.length - 1];
  const base = last + st.slope * days * 0.6;
  const band = last * st.sd * Math.sqrt(days);
  return { last, base, low: base - band, high: base + band, sd: st.sd };
}

/* ---------- análise local (sem IA) ---------- */
function localAnalysis(m, n) {
  const A = (id) => m.assets.find((a) => a.id === id && a.price != null);
  const items = (n && n.items) || [];
  const neg = items.filter((i) => i.tone === 'risco').length;
  const ratio = items.length ? neg / items.length : 0;
  const vix = A('vix'), gold = A('gold'), oil = A('wti'), usd = A('usdbrl'), btc = A('btc'), t10 = A('us10y');
  if (!m.assets.some((a) => a.price != null) && !items.length) {
    return {
      engine: 'local', updated: new Date().toISOString(),
      resumo: 'Sem dados no momento: o servidor não conseguiu acessar as fontes de cotações e notícias. Verifique a conexão de internet do servidor.',
      sentimento: 'neutro', risco_global: { score: null, nivel: 'Indisponível', fatores: ['Fontes de dados inacessíveis.'] },
      alertas: [], manchetes_chave: [], projecoes: [], oportunidades: [],
    };
  }
  let s = 25;
  const fat = [];
  if (vix) { s += clamp((vix.price - 14) * 2.2, 0, 35); fat.push(`VIX em ${fx(vix.price)} (${sg(vix.change)} no dia)`); }
  if (items.length) { s += ratio * 35; fat.push(`${Math.round(ratio * 100)}% das manchetes recentes têm tom de risco`); }
  if (gold && gold.change30d > 5) { s += 6; fat.push(`Ouro sobe ${sg(gold.change30d)} em ~30 pregões (busca por proteção)`); }
  if (oil && Math.abs(oil.change30d) > 12) { s += 5; fat.push(`Petróleo WTI oscila ${sg(oil.change30d)} em ~30 pregões`); }
  if (usd && usd.change30d > 4) { s += 4; fat.push(`Dólar sobe ${sg(usd.change30d)} contra o real em ~30 pregões`); }
  if (btc && btc.change30d < -15) { s += 5; fat.push(`Bitcoin cai ${sg(btc.change30d)} em ~30 pregões`); }
  if (t10 && t10.price > 4.8) { s += 4; fat.push(`Juro de 10 anos dos EUA alto (${fx(t10.price)}%)`); }
  s = Math.round(clamp(s, 5, 95));
  const nivel = s < 35 ? 'Baixo' : s < 55 ? 'Moderado' : s < 75 ? 'Elevado' : 'Crítico';

  const projecoes = [];
  for (const id of ['btc', 'gold', 'usdbrl', 'wti', 'ibov', 'spx']) {
    const a = A(id);
    if (!a || !a.series) continue;
    const p = project(a.series, 7);
    if (!p) continue;
    projecoes.push({
      ativo: a.name, horizonte: '7 dias',
      cenario_base: `Base ${fx(p.base)} (${sg(pct(p.base, p.last))})`,
      faixa: `${a.unit === 'pts' ? '' : a.unit + ' '}${fx(p.low)} - ${fx(p.high)}`,
      confianca: 'baixa',
      motivo: 'Extrapolação estatística: tendência dos últimos 20 pregões e volatilidade de 30. Não considera notícias.',
    });
  }
  const opp = [];
  if (s >= 55 && gold) opp.push({ tese: 'Demanda por proteção', ativos: ['Ouro'], racional: `Risco global ${nivel.toLowerCase()} e ouro em ${sg(gold.change30d)} em ~30 pregões.`, risco: 'Ouro também corrige quando os juros reais sobem.' });
  if (usd && usd.change30d > 3) opp.push({ tese: 'Pressão cambial', ativos: ['USD/BRL'], racional: `Dólar acumula ${sg(usd.change30d)} em ~30 pregões. Importadores e exportadores sentem o efeito de forma oposta.`, risco: 'Reversões rápidas são comuns após picos de volatilidade.' });
  if (btc && btc.change30d > 10) opp.push({ tese: 'Momentum em cripto', ativos: ['Bitcoin'], racional: `Alta de ${sg(btc.change30d)} em ~30 pregões.`, risco: 'Volatilidade alta e correlação com apetite a risco.' });
  if (oil && Math.abs(oil.change30d) > 8) opp.push({ tese: 'Volatilidade em energia', ativos: ['Petróleo'], racional: `WTI varia ${sg(oil.change30d)} em ~30 pregões.`, risco: 'Decisões da OPEP e geopolítica mudam o cenário de um dia para o outro.' });
  if (!opp.length) opp.push({ tese: 'Cenário sem sinais fortes', ativos: ['Diversificação'], racional: 'Nenhuma regra de oportunidade foi disparada pelos dados atuais.', risco: 'Acompanhe VIX, dólar e petróleo.' });

  const risky = items.filter((i) => i.tone === 'risco');
  return {
    engine: 'local',
    updated: new Date().toISOString(),
    resumo: `Análise por regras, sem IA generativa. Risco global ${nivel.toLowerCase()}, ${s} de 100. ${fat[0] || ''}`.trim(),
    sentimento: s < 35 ? 'otimista' : s < 55 ? 'neutro' : s < 75 ? 'cauteloso' : 'pessimista',
    risco_global: { score: s, nivel, fatores: fat.length ? fat : ['Sem dados suficientes no momento.'] },
    alertas: risky.slice(0, 3).map((i) => ({ texto: i.title, nivel: 'medio' })),
    manchetes_chave: risky.slice(0, 5).map((i) => ({ titulo: i.title, fonte: i.source, impacto: 'Tom de risco detectado por palavras-chave.', ativos: i.tags })),
    projecoes,
    oportunidades: opp,
  };
}

/* ---------- IA (Gemini, Groq ou Claude) ---------- */
async function askLLM(system, messages, max = 2600, json = false) {
  if (!PROVIDER) throw new Error('nenhuma IA configurada');
  const signal = AbortSignal.timeout(60000);
  if (PROVIDER === 'gemini') {
    const gc = { maxOutputTokens: max };
    if (json) gc.responseMimeType = 'application/json';
    if (/2\.5-flash/.test(MODELS.gemini)) gc.thinkingConfig = { thinkingBudget: 0 };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEYS.gemini },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: gc,
      }),
      signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts;
    if (!parts) throw new Error('resposta vazia do Gemini');
    return parts.map((p) => p.text || '').join('');
  }
  if (PROVIDER === 'groq') {
    const body = { model: MODELS.groq, max_tokens: Math.min(Math.max(max, 2000), 8000), temperature: json ? 0.3 : 0.6, messages: [{ role: 'system', content: system }, ...messages] };
    // Modelos gpt-oss raciocinam antes de responder; esforço baixo deixa a resposta rápida e barata.
    if (/^openai\/gpt-oss/.test(MODELS.groq)) body.reasoning_effort = 'low';
    const call = async (b) => {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + KEYS.groq }, body: JSON.stringify(b), signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
      return (((j.choices || [])[0] || {}).message || {}).content || '';
    };
    if (!json) return call(body);
    try { return await call({ ...body, response_format: { type: 'json_object' } }); }
    catch (e) {
      // Se o modelo não aceitar o modo JSON, tenta de novo sem ele (o prompt já exige JSON).
      if (/response_format|json/i.test(e.message)) return call(body);
      throw e;
    }
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELS.anthropic, max_tokens: max, system, messages }),
    signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}
function snapText(m, n, w, h) {
  const L = ['DATA/HORA: ' + new Date().toISOString() + ' (UTC)', '', 'COTAÇÕES (preço | var. dia | var. ~30 pregões | máx/mín 30 pregões):'];
  for (const a of m.assets) {
    if (a.error || a.price == null) { L.push(`- ${a.name}: indisponível`); continue; }
    const last = a.series.slice(-22);
    L.push(`- ${a.name}: ${fx(a.price)} ${a.unit} | dia ${sg(a.change)} | 30d ${sg(a.change30d)} | máx ${fx(Math.max(...last))} mín ${fx(Math.min(...last))}`);
  }
  if (m.fng) L.push('', `Índice Medo e Ganância (cripto): ${m.fng.value} (${m.fng.label})`);
  if (w && w.cities && w.cities.length) {
    L.push('', 'CLIMA AGORA:');
    w.cities.forEach((c) => L.push(`- ${c.name}: ${c.temp}°C, ${wxDesc(c.code).toLowerCase()}, vento ${c.wind} km/h`));
  }
  if (h) L.push('', hazardsText(h));
  L.push('', 'MANCHETES RECENTES (fonte | tom automático | título):');
  n.items.slice(0, 40).forEach((i) => L.push(`- [${i.source}] (${i.tone}) ${i.title}`));
  return L.join('\n');
}
const ANALYSIS_SYSTEM = `Você é o motor de análise da plataforma Zodam AI. Recebe cotações, clima e manchetes reais e produz uma análise em português do Brasil.
Regras:
- Use apenas os dados fornecidos. Não invente números nem notícias. Ao citar valores, use os que foram dados.
- Projeções são cenários probabilísticos com faixa e nível de confiança. Nunca trate como certeza.
- Não dê recomendação financeira personalizada. Oportunidades são hipóteses para estudo, sempre com o risco associado.
- Responda SOMENTE com JSON válido, sem markdown e sem texto fora do JSON.
Formato:
{"resumo":"3 a 4 frases","sentimento":"otimista|neutro|cauteloso|pessimista",
"risco_global":{"score":0-100,"nivel":"Baixo|Moderado|Elevado|Crítico","fatores":["3 a 5 itens"]},
"alertas":[{"texto":"","nivel":"alto|medio|baixo"}],
"manchetes_chave":[{"titulo":"","fonte":"","impacto":"efeito provável nos mercados","ativos":["..."]}],
"projecoes":[{"ativo":"","horizonte":"7 dias","cenario_base":"","faixa":"ex.: US$ 3.950 - 4.150","confianca":"baixa|média|alta","motivo":""}],
"oportunidades":[{"tese":"","ativos":["..."],"racional":"","risco":""}]}
Inclua projeções para Bitcoin, Ouro, Dólar, Petróleo, Ibovespa e S&P 500 (quando houver dado), nessa ordem. Inclua de 2 a 4 alertas, até 5 manchetes_chave e de 3 a 5 oportunidades.`;

let lastAI = 0;
async function getAnalysis(force) {
  const [m, n, w] = await Promise.all([getMarkets(), getNews(), getWeather().catch(() => null)]);
  const local = () => localAnalysis(m, n);
  if (!PROVIDER) return cached('analysis', 5 * 60e3, async () => local(), force);
  if (force && Date.now() - lastAI < 60e3) force = false;
  return cached('analysis', 15 * 60e3, async () => {
    try {
      lastAI = Date.now();
      const txt = await askLLM(ANALYSIS_SYSTEM, [{ role: 'user', content: snapText(m, n, w) }], 4096, true);
      const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      if (!j.risco_global) throw new Error('JSON sem risco_global');
      return { engine: PROVIDER, model: MODELS[PROVIDER], updated: new Date().toISOString(), ...j };
    } catch (e) {
      const v = local();
      v.note = 'Falha na IA: ' + e.message;
      v.noCache = true;
      return v;
    }
  }, force);
}

/* ---------- chat ---------- */
const ALIAS = {
  usdbrl: ['dólar', 'dolar', 'usd'], eurbrl: ['euro'], gold: ['ouro'], silver: ['prata'], wti: ['petróleo', 'petroleo', 'wti'],
  brent: ['brent'], copper: ['cobre'], soy: ['soja'], corn: ['milho'], btc: ['bitcoin', 'btc'], eth: ['ethereum', 'eth'],
  ibov: ['ibovespa', 'bolsa', 'ibov'], spx: ['s&p', 'sp500'], ndx: ['nasdaq'], vix: ['vix', 'volatilidade'], us10y: ['juros', 'treasury', '10 anos'], dxy: ['dxy'],
};
function localChat(msg, m, n) {
  const q = msg.toLowerCase();
  const out = [];
  for (const a of m.assets) {
    if ((ALIAS[a.id] || []).some((w) => q.includes(w)) && a.price != null) {
      out.push(`${a.name}: ${fx(a.price)} ${a.unit}, ${sg(a.change)} no dia e ${sg(a.change30d)} em cerca de 30 pregões.`);
    }
  }
  if (/risco|perigo|crise/.test(q)) {
    const r = localAnalysis(m, n).risco_global;
    out.push(r.score == null ? 'Risco global indisponível, pois não há dados de mercado agora.' : `Risco global ${r.nivel.toLowerCase()}, ${r.score} de 100. ${r.fatores[0] || ''}`);
  }
  if (/not[ií]cia|manchete|jornal/.test(q)) out.push('Manchetes recentes: ' + n.items.slice(0, 4).map((i) => `${i.title} (${i.source})`).join('. '));
  if (!out.length) out.push('Posso responder sobre cotações, risco global e manchetes. Para análises abertas, configure uma IA gratuita no servidor.');
  out.push('Estou em modo local, sem IA generativa.');
  return out.join(' ');
}
async function chat(message, history, voice) {
  const [m, n, w, h] = await Promise.all([getMarkets(), getNews(), getWeather().catch(() => null), getHazards().catch(() => null)]);
  if (!PROVIDER) return { engine: 'local', answer: localChat(message, m, n) };
  const an = cache.get('analysis');
  const extras = [];
  const wantsWx = WX_Q.test(message);
  const jobs = [];
  if (wantsWx) jobs.push(forecastText(message).then((t) => extras.push(t)).catch(() => {}));
  if (TAVILY_KEY && message.trim().length >= 12 && (!wantsWx || /not[ií]cia/i.test(message))) jobs.push(webSearch(message).then((t) => t && extras.push(t)).catch(() => {}));
  await Promise.all(jobs);
  const style = voice
    ? 'Responda como uma voz falada: no máximo 4 frases curtas, sem markdown, sem listas, sem símbolos, tom calmo e estratégico.'
    : 'Responda de forma direta e organizada; pode usar listas curtas.';
  const system = `Você é o Zodam, a inteligência central da plataforma Zodam AI, um holograma sábio e calmo, assistente geral que responde sobre qualquer assunto: notícias, esportes, ciência, tecnologia, cultura, saúde, cotidiano, mercado e o que mais o usuário perguntar. Responda em português do Brasil.
Fontes, nesta ordem: (1) a PESQUISA NA WEB abaixo, quando houver, para qualquer fato recente ou que você não tenha certeza; (2) a PREVISÃO DO TEMPO e os dados do painel (cotações, clima, manchetes); (3) seu conhecimento geral, para assuntos atemporais.
Se a pesquisa trouxer a resposta, responda e cite o nome do site de onde veio. Se a pesquisa não trouxer, ou não houver pesquisa, diga com honestidade o que sabe e o que não conseguiu confirmar, sem inventar fatos, números, placares, datas ou notícias. Tentar e não achar é aceitável; inventar não é.
Em temas de mercado, projeções são cenários, nunca certezas, e você não dá recomendação financeira personalizada; ofereça hipóteses e riscos. Em saúde e direito, informe de forma geral e indique um profissional quando for sério.
${style}

${snapText(m, n, w, h)}
${extras.length ? '\n' + extras.join('\n\n') + '\n' : ''}${an && an.v ? '\nANÁLISE ATUAL DO PAINEL (resumo): ' + JSON.stringify({ resumo: an.v.resumo, risco: an.v.risco_global, oportunidades: an.v.oportunidades }) : ''}`;
  const msgs = (history || []).filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string').slice(-8).map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  msgs.push({ role: 'user', content: message.slice(0, 2000) });
  try { return { engine: PROVIDER, answer: (await askLLM(system, msgs, 1200)).trim() }; }
  catch (e) { return { engine: 'local', answer: localChat(message, m, n) + ' Falha na IA: ' + e.message }; }
}

/* ---------- voz (ElevenLabs) ---------- */
const sameOrigin = (req) => {
  const o = req.headers.origin;
  if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
};
const hits = [];
function allow(max) {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60e3) hits.shift();
  if (hits.length >= max) return false;
  hits.push(now);
  return true;
}
async function tts(text) {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN.voice)}?output_format=mp3_44100_64`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'audio/mpeg', 'xi-api-key': ELEVEN.key },
    body: JSON.stringify({
      text, model_id: ELEVEN.model,
      voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const d = j.detail;
    const msg = (d && (d.message || d.status)) || (typeof d === 'string' ? d : '') || 'HTTP ' + r.status;
    const e = new Error(msg);
    e.status = r.status;
    throw e;
  }
  return Buffer.from(await r.arrayBuffer());
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, no) => {
  // Na Vercel o corpo JSON já vem lido em req.body.
  if (req.body !== undefined) return ok(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
  let d = '';
  req.on('data', (c) => { d += c; if (d.length > 1e5) { no(new Error('corpo grande')); req.destroy(); } });
  req.on('end', () => ok(d));
  req.on('error', no);
});

const handle = async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const force = u.searchParams.get('refresh') === '1';
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, ai: !!PROVIDER, provider: PROVIDER || null, model: PROVIDER ? MODELS[PROVIDER] : null, tts: !!ELEVEN.key, search: !!TAVILY_KEY });
    if (u.pathname === '/api/markets') return send(res, 200, await getMarkets(force));
    if (u.pathname === '/api/news') return send(res, 200, await getNews(force));
    if (u.pathname === '/api/weather') return send(res, 200, await getWeather(force).catch((e) => ({ cities: [], error: e.message })));
    if (u.pathname === '/api/hazards') return send(res, 200, await getHazards(force));
    if (u.pathname === '/api/analysis') return send(res, 200, await getAnalysis(force));
    if (u.pathname === '/api/tts' && req.method === 'POST') {
      if (!ELEVEN.key) return send(res, 503, { error: 'ElevenLabs não configurado' });
      if (!sameOrigin(req)) return send(res, 403, { error: 'origem não permitida' });
      if (!allow(25)) return send(res, 429, { error: 'muitas requisições de voz, aguarde um minuto' });
      const b = JSON.parse((await readBody(req)) || '{}');
      const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 420);
      if (!text) return send(res, 400, { error: 'texto vazio' });
      try { return send(res, 200, await tts(text), 'audio/mpeg'); }
      catch (e) { return send(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 502, { error: e.message }); }
    }
    if (u.pathname === '/api/chat' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'origem não permitida' });
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.message || typeof b.message !== 'string') return send(res, 400, { error: 'mensagem vazia' });
      return send(res, 200, await chat(b.message, b.history, !!b.voice));
    }
    if (u.pathname.startsWith('/api/')) return send(res, 404, { error: 'não encontrado' });
    const rel = u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname).replace(/^\/+/, '');
    const file = path.join(__dirname, 'public', rel);
    if (!file.startsWith(path.join(__dirname, 'public'))) return send(res, 403, 'proibido', 'text/plain');
    fs.readFile(file, (e, buf) => (e ? send(res, 404, 'não encontrado', 'text/plain') : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream')));
  } catch (e) {
    send(res, 500, { error: e.message });
  }
};
const server = http.createServer(handle);

if (require.main === module) {
  server.listen(PORT, () => console.log(`Zodam AI em http://localhost:${PORT}  |  IA: ${PROVIDER ? PROVIDER + ' (' + MODELS[PROVIDER] + ')' : 'modo local (sem chave de IA)'}`));
}
// Exporta o handler (usado pelas funções da Vercel em /api) e utilitários de teste.
module.exports = handle;
Object.assign(module.exports, { getHazards, hazardsText, KP_TXT, parseRSS, project, localAnalysis, toneOf, stats });
