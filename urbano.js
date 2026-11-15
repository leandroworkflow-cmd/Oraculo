/* PRIVATE URBAN INTELLIGENCE — módulo privado de câmeras (Belo Horizonte).
   Acesso só com a chave URBAN_ACCESS_KEY (cookie de sessão HttpOnly assinado).
   As câmeras vêm de URBAN_CAMERAS (JSON) ou do arquivo cameras.json: use só fontes autorizadas. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ACCESS_KEY = process.env.URBAN_ACCESS_KEY || '';
const SECRET = process.env.URBAN_SESSION_SECRET || (ACCESS_KEY ? crypto.createHash('sha256').update('urbano:' + ACCESS_KEY).digest('hex') : '');
const TTL = 12 * 3600e3;
const COOKIE = 'urb_sess';
const BH = { lat: -19.9167, lng: -43.9345 };

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = (p) => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');

function makeToken() {
  const p = String(Date.now() + TTL);
  return p + '.' + sign(p);
}
function validToken(t) {
  if (!t || !SECRET) return false;
  const [p, s] = String(t).split('.');
  if (!p || !s || !/^\d+$/.test(p) || Number(p) < Date.now()) return false;
  try { return safeEq(s, sign(p)); } catch { return false; }
}
const cookieOf = (req, name) => {
  const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
};
const authed = (req) => validToken(cookieOf(req, COOKIE));

/* limite simples de tentativas de login (por instância) */
const fails = new Map();
function blocked(ip) {
  const f = fails.get(ip);
  return f && f.n >= 5 && Date.now() - f.t < 15 * 60e3;
}
function fail(ip) {
  const f = fails.get(ip);
  fails.set(ip, { n: f && Date.now() - f.t < 15 * 60e3 ? f.n + 1 : 1, t: Date.now() });
}

function loadCameras() {
  let raw = process.env.URBAN_CAMERAS || '';
  if (!raw) {
    try { raw = fs.readFileSync(path.join(__dirname, 'cameras.json'), 'utf8'); } catch { raw = '[]'; }
  }
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && c.id && c.nome && c.url && Number.isFinite(+c.lat) && Number.isFinite(+c.lng))
    .map((c) => ({
      id: String(c.id), nome: String(c.nome), regiao: String(c.regiao || 'Outras'),
      lat: +c.lat, lng: +c.lng, tipo: ['imagem', 'hls', 'embed'].includes(c.tipo) ? c.tipo : 'imagem',
      url: String(c.url), atualizar: Math.max(3, +c.atualizar || 10), fonte: String(c.fonte || ''),
    }));
}
// O que o navegador recebe: câmeras de imagem passam pelo servidor (a URL original não vai para o cliente).
const publicCam = (c) => ({ ...c, url: c.tipo === 'imagem' ? undefined : c.url });

async function weatherBH(getJSON) {
  const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${BH.lat}&longitude=${BH.lng}&current=temperature_2m,weather_code,wind_speed_10m,precipitation&hourly=precipitation_probability&forecast_days=1&timezone=America%2FSao_Paulo`);
  const c = j.current || {};
  const probs = (j.hourly && j.hourly.precipitation_probability) || [];
  const h = new Date().getHours();
  return { temp: c.temperature_2m, vento: c.wind_speed_10m, chuvaAgora: c.precipitation, codigo: c.weather_code, chuvaProx6h: Math.max(0, ...probs.slice(h, h + 6)) };
}

const SYSTEM = `Você é o Zodam, IA do painel privado PRIVATE URBAN INTELLIGENCE de Belo Horizonte. Recebe o clima atual e a lista de câmeras monitoradas. Responda em português do Brasil, em no máximo 6 linhas, direto: condição do tempo, impacto provável no trânsito e quais regiões merecem atenção. Você NÃO vê as imagens das câmeras: nunca invente o que elas mostram, não identifique pessoas nem placas. Se faltar dado, diga que falta.`;

module.exports = async function urbano(req, res, u, h) {
  const { send, readBody, sameOrigin, askLLM, getJSON, hasAI } = h;
  if (!ACCESS_KEY) return send(res, 503, { error: 'Módulo privado desligado: defina URBAN_ACCESS_KEY no servidor.' });
  const acao = u.searchParams.get('acao') || 'status';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (acao === 'login' && req.method === 'POST') {
    if (!sameOrigin(req)) return send(res, 403, { error: 'origem não permitida' });
    if (blocked(ip)) return send(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
    let b = {};
    try { b = JSON.parse((await readBody(req)) || '{}'); } catch {}
    if (!b.chave || !safeEq(b.chave, ACCESS_KEY)) { fail(ip); return send(res, 401, { error: 'Chave inválida.' }); }
    fails.delete(ip);
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Strict; Path=/api/urbano; Max-Age=${TTL / 1000}${secure}`);
    return send(res, 200, { ok: true });
  }
  if (acao === 'sair') {
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/api/urbano; Max-Age=0`);
    return send(res, 200, { ok: true });
  }
  if (!authed(req)) return send(res, 401, { error: 'não autenticado', login: true });

  if (acao === 'status') return send(res, 200, { ok: true });
  if (acao === 'cameras') return send(res, 200, { cameras: loadCameras().map(publicCam) });

  if (acao === 'snap') {
    const cam = loadCameras().find((c) => c.id === u.searchParams.get('id'));
    if (!cam || cam.tipo !== 'imagem') return send(res, 404, { error: 'câmera não encontrada' });
    try {
      const r = await fetch(cam.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZodamAI/1.0)' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) return send(res, 502, { error: 'fonte respondeu HTTP ' + r.status });
      const type = r.headers.get('content-type') || 'image/jpeg';
      if (!/^image\//i.test(type)) return send(res, 502, { error: 'fonte não devolveu imagem' });
      return send(res, 200, Buffer.from(await r.arrayBuffer()), type);
    } catch (e) { return send(res, 502, { error: 'fonte indisponível' }); }
  }

  if (acao === 'analise') {
    const regiao = u.searchParams.get('regiao') || '';
    const cams = loadCameras().filter((c) => !regiao || c.regiao === regiao);
    let w = null;
    try { w = await weatherBH(getJSON); } catch {}
    const resumo = w
      ? `Agora em BH: ${w.temp}°C, vento ${w.vento} km/h, chuva ${w.chuvaAgora} mm, prob. máx. de chuva nas próximas 6h: ${w.chuvaProx6h}%.`
      : 'Clima de BH indisponível agora.';
    const lista = cams.map((c) => `${c.nome} (${c.regiao})`).join('; ') || 'nenhuma câmera cadastrada';
    if (!hasAI()) return send(res, 200, { engine: 'local', clima: w, texto: resumo + (w && w.chuvaProx6h >= 60 ? ' Chuva provável: atenção a alagamentos e trânsito lento.' : ' Sem sinal forte de chuva nas próximas horas.') + ' Câmeras: ' + lista + '.' });
    try {
      const texto = await askLLM(SYSTEM, [{ role: 'user', content: `${resumo}\nRegião: ${regiao || 'todas'}\nCâmeras: ${lista}` }], 600);
      return send(res, 200, { engine: 'ia', clima: w, texto: String(texto).trim() });
    } catch (e) { return send(res, 200, { engine: 'local', clima: w, texto: resumo + ' (IA indisponível: ' + e.message + ')' }); }
  }
  return send(res, 404, { error: 'ação desconhecida' });
};
