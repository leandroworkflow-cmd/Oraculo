'use strict';
/**
 * MarketOS — servidor.
 * Busca cotações (Yahoo Finance, AwesomeAPI, CoinGecko, alternative.me) e notícias (RSS de jornais),
 * calcula análise local, e usa a API da Anthropic (Claude) para análise e chat quando há chave.
 * Sem dependências: Node 18+.
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
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const UA = 'Mozilla/5.0 (compatible; MarketOS/1.0)';

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
async function yahoo(sym) {
  const j = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=6mo&interval=1d`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('Yahoo sem dados para ' + sym);
  const cl = (r.indicators && r.indicators.quote && r.indicators.quote[0].close) || [];
  const ts = r.timestamp || [];
  const series = [], dates = [];
  cl.forEach((v, i) => {
    if (v != null) { series.push(v); dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10)); }
  });
  if (series.length < 2) throw new Error('Série curta para ' + sym);
  const live = r.meta && r.meta.regularMarketPrice;
  if (live != null) series[series.length - 1] = live;
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
  { id: 'usdbrl', name: 'Dólar (USD/BRL)', short: 'USD/BRL', group: 'Câmbio', unit: 'R$', yf: 'BRL=X', fb: () => awesome('USD-BRL') },
  { id: 'eurbrl', name: 'Euro (EUR/BRL)', short: 'EUR/BRL', group: 'Câmbio', unit: 'R$', yf: 'EURBRL=X', fb: () => awesome('EUR-BRL') },
  { id: 'dxy', name: 'Índice Dólar (DXY)', short: 'DXY', group: 'Câmbio', unit: 'pts', yf: 'DX-Y.NYB' },
  { id: 'gold', name: 'Ouro (oz)', short: 'OURO', group: 'Commodities', unit: 'US$', yf: 'GC=F' },
  { id: 'silver', name: 'Prata (oz)', short: 'PRATA', group: 'Commodities', unit: 'US$', yf: 'SI=F' },
  { id: 'wti', name: 'Petróleo WTI', short: 'WTI', group: 'Commodities', unit: 'US$', yf: 'CL=F' },
  { id: 'brent', name: 'Petróleo Brent', short: 'BRENT', group: 'Commodities', unit: 'US$', yf: 'BZ=F' },
  { id: 'copper', name: 'Cobre (lb)', short: 'COBRE', group: 'Commodities', unit: 'US$', yf: 'HG=F' },
  { id: 'btc', name: 'Bitcoin', short: 'BTC', group: 'Cripto', unit: 'US$', yf: 'BTC-USD', fb: () => coingecko('bitcoin') },
  { id: 'eth', name: 'Ethereum', short: 'ETH', group: 'Cripto', unit: 'US$', yf: 'ETH-USD', fb: () => coingecko('ethereum') },
  { id: 'ibov', name: 'Ibovespa', short: 'IBOV', group: 'Bolsas e juros', unit: 'pts', yf: '^BVSP' },
  { id: 'spx', name: 'S&P 500', short: 'S&P', group: 'Bolsas e juros', unit: 'pts', yf: '^GSPC' },
  { id: 'ndx', name: 'Nasdaq', short: 'NASDAQ', group: 'Bolsas e juros', unit: 'pts', yf: '^IXIC' },
  { id: 'vix', name: 'VIX (volatilidade)', short: 'VIX', group: 'Bolsas e juros', unit: 'pts', yf: '^VIX' },
  { id: 'us10y', name: 'Juro EUA 10 anos', short: 'US10Y', group: 'Bolsas e juros', unit: '%', yf: '^TNX' },
];

async function fetchAsset(a) {
  const meta = { id: a.id, name: a.name, short: a.short, group: a.group, unit: a.unit };
  const errs = [];
  let r = null;
  try { r = await yahoo(a.yf); } catch (e) { errs.push(e.message); }
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
const NEG = ['war', 'attack', 'strike', 'missile', 'sanction', 'crisis', 'recession', 'tariff', 'default', 'collapse', 'invasion', 'conflict', 'crash', 'plunge', 'tumble', 'shutdown', 'bankrupt', 'inflation', 'famine', 'terror', 'explosion', 'killed', 'threat', 'ceasefire collapse', 'guerra', 'ataque', 'sanç', 'crise', 'recess', 'tarifa', 'calote', 'colapso', 'conflito', 'queda', 'inflação', 'míssil', 'bomba', 'ameaça'];
const POS = ['rally', 'growth', 'deal', 'ceasefire', 'record high', 'rate cut', 'recovery', 'surge', 'agreement', 'peace', 'boost', 'beats', 'acordo', 'crescimento', 'alta', 'cessar-fogo', 'recupera', 'avanço', 'paz', 'recorde'];
const TAGS = {
  'Petróleo': /\boil\b|crude|opec|petr[óo]leo|brent/,
  'Ouro': /\bgold\b|\bouro\b/,
  'Cripto': /bitcoin|crypto|cripto|ethereum/,
  'Dólar': /dollar|d[óo]lar|forex/,
  'China': /china|beijing|pequim|yuan/,
  'Juros/Fed': /federal reserve|\bfed\b|powell|interest rate|rate cut|juros|selic|copom/,
  'Brasil': /brazil|brasil|lula|ibovespa|petrobras/,
  'Geopolítica': /\bwar\b|ukraine|russia|gaza|israel|iran|ucr[âa]nia|guerra|nato|otan/,
  'Tarifas': /tariff|trade war|tarifa|sanction|sanç/,
};
function toneOf(text) {
  const t = text.toLowerCase();
  const neg = NEG.filter((w) => t.includes(w)).length;
  const pos = POS.filter((w) => t.includes(w)).length;
  const tone = neg > pos ? 'risco' : pos > neg ? 'positivo' : 'neutro';
  const tags = Object.keys(TAGS).filter((k) => TAGS[k].test(t));
  return { tone, tags };
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
    items.push({ source, title, link, desc, ts: when, ...toneOf(title + ' ' + desc) });
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
  for (const id of ['usdbrl', 'gold', 'wti', 'btc', 'ibov', 'spx']) {
    const a = A(id);
    if (!a || !a.series) continue;
    const p = project(a.series, 7);
    if (!p) continue;
    projecoes.push({
      ativo: a.name, horizonte: '7 dias',
      cenario_base: `${fx(p.base)} (${sg(pct(p.base, p.last))})`,
      faixa: `${fx(p.low)} a ${fx(p.high)}`,
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

  const key = items.filter((i) => i.tone === 'risco').slice(0, 5).map((i) => ({ titulo: i.title, fonte: i.source, impacto: 'Tom de risco detectado por palavras-chave.', ativos: i.tags }));
  return {
    engine: 'local',
    updated: new Date().toISOString(),
    resumo: `Análise por regras (sem IA). Risco global ${nivel.toLowerCase()} (${s}/100). ${fat[0] || 'Dados insuficientes.'}`,
    sentimento: s < 35 ? 'otimista' : s < 55 ? 'neutro' : s < 75 ? 'cauteloso' : 'pessimista',
    risco_global: { score: s, nivel, fatores: fat.length ? fat : ['Sem dados suficientes no momento.'] },
    alertas: [],
    manchetes_chave: key,
    projecoes,
    oportunidades: opp,
  };
}

/* ---------- Claude ---------- */
async function askClaude(system, messages, max = 2600) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: max, system, messages }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
}
function snapText(m, n) {
  const L = ['DATA/HORA: ' + new Date().toISOString() + ' (UTC)', '', 'COTAÇÕES (preço | var. dia | var. ~30 pregões | máx/mín 30 pregões):'];
  for (const a of m.assets) {
    if (a.error || a.price == null) { L.push(`- ${a.name}: indisponível`); continue; }
    const last = a.series.slice(-22);
    L.push(`- ${a.name}: ${fx(a.price)} ${a.unit} | dia ${sg(a.change)} | 30d ${sg(a.change30d)} | máx ${fx(Math.max(...last))} mín ${fx(Math.min(...last))}`);
  }
  if (m.fng) L.push('', `Índice Medo e Ganância (cripto): ${m.fng.value} (${m.fng.label})`);
  L.push('', 'MANCHETES RECENTES (fonte | tom automático | título):');
  n.items.slice(0, 40).forEach((i) => L.push(`- [${i.source}] (${i.tone}) ${i.title}`));
  return L.join('\n');
}
const ANALYSIS_SYSTEM = `Você é o motor de análise da plataforma MarketOS. Recebe cotações e manchetes reais e produz uma análise em português do Brasil.
Regras:
- Use apenas os dados fornecidos. Não invente números nem notícias. Ao citar valores, use os que foram dados.
- Projeções são cenários probabilísticos com faixa e nível de confiança. Nunca trate como certeza.
- Não dê recomendação financeira personalizada. Oportunidades são hipóteses para estudo, sempre com o risco associado.
- Responda SOMENTE com JSON válido, sem markdown e sem texto fora do JSON.
Formato:
{"resumo":"3 a 4 frases","sentimento":"otimista|neutro|cauteloso|pessimista",
"risco_global":{"score":0-100,"nivel":"Baixo|Moderado|Elevado|Crítico","fatores":["3 a 5 itens"]},
"alertas":["0 a 3 itens"],
"manchetes_chave":[{"titulo":"","fonte":"","impacto":"efeito provável nos mercados","ativos":["..."]}],
"projecoes":[{"ativo":"","horizonte":"7 dias","cenario_base":"","faixa":"","confianca":"baixa|média|alta","motivo":""}],
"oportunidades":[{"tese":"","ativos":["..."],"racional":"","risco":""}]}
Inclua projeções para Dólar, Ouro, Petróleo, Bitcoin, Ibovespa e S&P 500 (quando houver dado), até 5 manchetes_chave e de 3 a 5 oportunidades.`;

let lastAI = 0;
async function getAnalysis(force) {
  const m = await getMarkets(), n = await getNews();
  const local = () => localAnalysis(m, n);
  if (!KEY) return cached('analysis', 5 * 60e3, async () => local(), force);
  if (force && Date.now() - lastAI < 60e3) force = false;
  return cached('analysis', 15 * 60e3, async () => {
    try {
      lastAI = Date.now();
      const txt = await askClaude(ANALYSIS_SYSTEM, [{ role: 'user', content: snapText(m, n) }]);
      const j = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
      if (!j.risco_global) throw new Error('JSON sem risco_global');
      return { engine: 'claude', model: MODEL, updated: new Date().toISOString(), ...j };
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
  brent: ['brent'], copper: ['cobre'], btc: ['bitcoin', 'btc'], eth: ['ethereum', 'eth'], ibov: ['ibovespa', 'bolsa', 'ibov'],
  spx: ['s&p', 'sp500'], ndx: ['nasdaq'], vix: ['vix', 'volatilidade'], us10y: ['juros', 'treasury', '10 anos'], dxy: ['dxy'],
};
function localChat(msg, m, n) {
  const q = msg.toLowerCase();
  const out = [];
  for (const a of m.assets) {
    if ((ALIAS[a.id] || []).some((w) => q.includes(w)) && a.price != null) {
      out.push(`**${a.name}**: ${fx(a.price)} ${a.unit} (${sg(a.change)} no dia, ${sg(a.change30d)} em ~30 pregões).`);
    }
  }
  if (/risco|perigo|crise/.test(q)) {
    const r = localAnalysis(m, n).risco_global;
    out.push(r.score == null ? '**Risco global**: indisponível, pois não há dados de mercado agora.' : `**Risco global**: ${r.nivel} (${r.score}/100).\n- ` + r.fatores.join('\n- '));
  }
  if (/not[ií]cia|manchete|jornal/.test(q)) out.push('**Manchetes recentes**:\n- ' + n.items.slice(0, 5).map((i) => `${i.title} (${i.source})`).join('\n- '));
  if (!out.length) out.push('Posso responder sobre cotações (dólar, ouro, petróleo, bitcoin, Ibovespa...), risco global e manchetes. Para análises abertas, configure a chave da IA.');
  out.push('_Modo local: respostas por regras. Defina ANTHROPIC_API_KEY para conversar com a IA._');
  return out.join('\n\n');
}
async function chat(message, history) {
  const [m, n] = await Promise.all([getMarkets(), getNews()]);
  if (!KEY) return { engine: 'local', answer: localChat(message, m, n) };
  const an = cache.get('analysis');
  const system = `Você é o analista de IA da plataforma MarketOS. Responda em português do Brasil, de forma direta e organizada, usando APENAS os dados do painel abaixo.
Se a pergunta exigir algo que não está nos dados, diga isso. Não invente cotações nem notícias. Projeções são cenários, nunca certezas. Não dê recomendação financeira personalizada; ofereça hipóteses e riscos.

${snapText(m, n)}
${an && an.v ? '\nANÁLISE ATUAL DO PAINEL (resumo): ' + JSON.stringify({ resumo: an.v.resumo, risco: an.v.risco_global, oportunidades: an.v.oportunidades }) : ''}`;
  const msgs = (history || []).filter((h) => h && ['user', 'assistant'].includes(h.role) && typeof h.content === 'string').slice(-8).map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  msgs.push({ role: 'user', content: message.slice(0, 2000) });
  try { return { engine: 'claude', answer: await askClaude(system, msgs, 1200) }; }
  catch (e) { return { engine: 'local', answer: localChat(message, m, n) + '\n\n_Falha na IA: ' + e.message + '_' }; }
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok, no) => {
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
    if (u.pathname === '/api/health') return send(res, 200, { ok: true, ai: !!KEY, model: KEY ? MODEL : null });
    if (u.pathname === '/api/markets') return send(res, 200, await getMarkets(force));
    if (u.pathname === '/api/news') return send(res, 200, await getNews(force));
    if (u.pathname === '/api/analysis') return send(res, 200, await getAnalysis(force));
    if (u.pathname === '/api/chat' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      if (!b.message || typeof b.message !== 'string') return send(res, 400, { error: 'mensagem vazia' });
      return send(res, 200, await chat(b.message, b.history));
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
  server.listen(PORT, () => console.log(`MarketOS em http://localhost:${PORT}  |  IA: ${KEY ? 'Claude (' + MODEL + ')' : 'modo local (sem ANTHROPIC_API_KEY)'}`));
}
module.exports = handle;
Object.assign(module.exports, { parseRSS, project, localAnalysis, toneOf, stats });
