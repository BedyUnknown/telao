const fs = require('fs'), path = require('path'), http = require('http'), https = require('https'), crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.get('/healthz', (req, res) => res.type('text').send('ok'));   // para monitor de uptime / health check do Render
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- RNNoise (IA de supressão de ruído): acha os arquivos onde quer que a biblioteca os coloque ---------- */
const nsRoot = path.join(__dirname, 'node_modules/@sapphi-red/web-noise-suppressor');
const listAll = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(f => f.isDirectory() ? listAll(path.join(d, f.name)) : [path.join(d, f.name)]);
try {
  const all = listAll(nsRoot);
  const find = n => all.find(f => path.basename(f) === n);
  const pkg = JSON.parse(fs.readFileSync(path.join(nsRoot, 'package.json'), 'utf8'));
  let entry = pkg.module || pkg.main;
  const ex = pkg.exports && (pkg.exports['.'] || pkg.exports);
  if (!entry && ex) entry = typeof ex === 'string' ? ex : (ex.import || ex.default);
  if (entry && typeof entry === 'object') entry = entry.import || entry.default;
  const resolve = n => {   // usa o mapa "exports" do pacote; se falhar, procura pelo nome
    const t = pkg.exports && pkg.exports['./' + n];
    let tp = typeof t === 'string' ? t : t && (t.import || t.default);
    if (tp && typeof tp === 'object') tp = tp.import || tp.default;
    if (tp && fs.existsSync(path.join(nsRoot, tp))) return path.join(nsRoot, tp);
    return find(n) || (n.endsWith('.js') ? all.find(f => /rnnoise/i.test(f) && /worklet/i.test(f) && f.endsWith('.js')) : null);
  };
  const entryPath = path.join(nsRoot, entry);
  app.get('/ns/index.js', (req, res) => res.sendFile(entryPath));
  for (const n of ['rnnoiseWorklet.js', 'rnnoise.wasm', 'rnnoise_simd.wasm']) {
    const f = resolve(n);
    if (!f) console.warn('RNNoise', n, 'NAO ENCONTRADO');
    if (f) { app.get('/ns/' + n, (req, res) => res.sendFile(f)); if (n.endsWith('.js')) app.use('/ns', express.static(path.dirname(f))); }
  }
  app.use('/ns', express.static(path.dirname(entryPath)));
} catch (e) { console.warn('RNNoise não encontrado (rode npm install):', e.message); }

/* ---------- utilidades ---------- */
const clientIp = req => {   // melhor esforço: Cloudflare/proxy do host informam o IP real nesses cabeçalhos
  const h = req.headers;
  return String(h['cf-connecting-ip'] || (h['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?');
};

const buckets = new Map();   // contador de janela fixa: key -> { n, until }
function hit(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.until <= now) { b = { n: 0, until: now + windowMs }; buckets.set(key, b); }
  return ++b.n;
}
function count(key) {
  const b = buckets.get(key);
  return b && b.until > Date.now() ? b.n : 0;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.until <= now) buckets.delete(k); }, 60000).unref();

const FAIL_IP_MAX = 8, FAIL_GLOBAL_MAX = 300, FAIL_WINDOW = 60000;   // tentativas erradas de entrar numa sala
const blocked = ip => count('fail:' + ip) >= FAIL_IP_MAX || count('fail:*') >= FAIL_GLOBAL_MAX;
const failed = ip => { hit('fail:' + ip, FAIL_WINDOW); hit('fail:*', FAIL_WINDOW); };

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', CODE_RE = /^[A-Z0-9]{6}$/;
const MAX_ROOMS = 200, MAX_MEMBERS = 12;
const newCode = () => Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
const cleanNick = s => String(s ?? '')
  .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, 20);

/* ---------- servidores ICE (STUN + TURN opcional) ---------- */
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
let iceCache = null, icePending = null;
async function loadIce() {
  const env = process.env, out = [...STUN];
  try {
    if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {   // Cloudflare Realtime TURN (credenciais temporárias)
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) throw new Error('Cloudflare TURN HTTP ' + r.status);
      const j = await r.json(), list = [].concat(j.iceServers || []);
      for (const s of list) {
        const urls = [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u));   // navegadores bloqueiam a porta 53
        if (urls.length && (s.username || !urls.every(u => u.startsWith('turn')))) out.push({ ...s, urls });
      }
    } else if (env.TURN_URLS && env.TURN_USER && env.TURN_PASS) {   // TURN estático (Metered, coturn próprio, etc.)
      out.push({ urls: env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username: env.TURN_USER, credential: env.TURN_PASS });
    }
  } catch (e) { console.warn('TURN indisponível, usando só STUN:', e.message); return { ice: out, ttl: 60000 }; }
  return { ice: out, ttl: 6 * 3600 * 1000 };
}
async function getIce() {
  if (iceCache && iceCache.until > Date.now()) return iceCache.ice;
  icePending = icePending || loadIce().then(r => { iceCache = { ice: r.ice, until: Date.now() + r.ttl }; return r.ice; }).finally(() => { icePending = null; });
  return icePending;
}

/* ---------- HTTP: atalho global do microfone (ex.: AutoHotkey) ---------- */
const hotkeys = new Map();   // token do host -> ws do host
const tx = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
app.post('/api/mic', (req, res) => {
  if (hit('mic:' + clientIp(req), 10000) > 20) return res.sendStatus(429);
  const host = hotkeys.get(String(req.headers['x-telao-token'] || ''));
  if (!host) return res.sendStatus(404);
  tx(host, { t: 'toggle-mic' });
  res.sendStatus(204);
});

const PORT = process.env.PORT || 3000;
const hasCert = fs.existsSync('key.pem') && fs.existsSync('cert.pem');
const server = hasCert
  ? https.createServer({ key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') }, app)
  : http.createServer(app);

/* ---------- salas (WebSocket) ---------- */
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });   // padrão da lib é 100 MB
const rooms = new Map();   // id -> { owner, passHash, members: Map(id -> ws), chat: [] }
let uid = 0, chatSeq = 0;
const MAX_CHAT = 200, MIN_PASS = 5;
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const passOk = (r, p) => crypto.timingSafeEqual(sha(p ?? ''), r.passHash);
const err = (ws, msg, code) => tx(ws, { t: 'error', msg, code });

function roster(r) {
  const list = [...r.members.values()].map(p => ({ id: p.id, nick: p.nick, owner: p === r.owner, pc: p.kind === 'pc', sharing: !!p.sharing }));
  list.sort((a, b) => b.owner - a.owner);   // dono primeiro (ordem de entrada nos demais)
  r.members.forEach(p => tx(p, { t: 'roster', list }));
}
function uniqueNick(r, nick) {
  const used = new Set([...r.members.values()].map(p => p.nick.toLowerCase()));
  let n = nick, i = 1;
  while (used.has(n.toLowerCase())) n = `${nick.slice(0, 16)} (${++i})`;
  return n;
}
function publicRooms() {   // lista de salas abertas (código e nomes; a senha protege a entrada)
  return [...rooms.entries()].map(([id, r]) => ({
    id, owner: r.owner.nick, count: r.members.size, max: MAX_MEMBERS,
    people: [...r.members.values()].map(p => p.nick),
    sharing: [...r.members.values()].filter(p => p.sharing).length
  })).sort((a, b) => b.count - a.count);
}
app.get('/api/rooms', (req, res) => {
  if (hit('rooms:' + clientIp(req), 60000) > 90) return res.sendStatus(429);
  res.set('Cache-Control', 'no-store').json(publicRooms());
});

function enterRoom(ws, r, id, m, ice) {   // coloca ws na sala (já validado)
  ws.room = id; ws.kind = m.kind === 'pc' ? 'pc' : 'mobile'; ws.sharing = false;
  ws.nick = uniqueNick(r, cleanNick(m.nick));
  if (ws.kind === 'pc' && typeof m.hk === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(m.hk)) { ws.hk = m.hk; hotkeys.set(m.hk, ws); }
  const existing = [...r.members.keys()];
  r.members.set(ws.id, ws);
  tx(ws, { t: 'joined', room: id, me: ws.id, owner: r.owner.id, peers: existing, ice });
  tx(ws, { t: 'history', list: r.chat });
  r.members.forEach((p, pid) => pid !== ws.id && tx(p, { t: 'peer-joined', id: ws.id }));
  roster(r);
}
function createRoom(ws, m, want, ice) {
  const pass = String(m.pass ?? '').slice(0, 64);
  const id = want || (() => { let c; do { c = newCode(); } while (rooms.has(c)); return c; })();
  const r = { owner: ws, passHash: sha(pass), members: new Map(), chat: [] };
  rooms.set(id, r);
  ws.kind = 'pc';
  enterRoom(ws, r, id, { ...m, kind: 'pc' }, ice);
}

wss.on('connection', (ws, req) => {
  ws.id = String(++uid);
  ws.ip = clientIp(req);
  ws.alive = true;
  ws.w0 = Date.now(); ws.mc = 0;
  ws.on('error', () => {});   // sem isso, um frame inválido derruba o processo
  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', async (raw, isBinary) => {
    if (isBinary) return;
    const now = Date.now();
    if (now - ws.w0 > 10000) { ws.w0 = now; ws.mc = 0; }
    if (++ws.mc > 600) return ws.close(1008, 'rate limit');
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || m.t === 'ping') return;   // ping = keep-alive do cliente

    try {
      if (m.t === 'create' || m.t === 'join') {
        if (ws.room) return err(ws, 'Você já está em uma sala');
        const nick = cleanNick(m.nick);
        if (nick.length < 2) return err(ws, 'Nick obrigatório (mínimo 2 caracteres)', 'nick');
        const code = String(m.room || '').trim().toUpperCase();
        let r = m.t === 'join' ? (CODE_RE.test(code) ? rooms.get(code) : null) : null;
        const wantsCreate = m.t === 'create' || (m.t === 'join' && !r && m.create === true);   // join+create: dono voltando depois de uma queda
        if (m.t === 'join' && blocked(ws.ip)) return err(ws, 'Muitas tentativas. Aguarde 1 minuto.', 'blocked');

        if (!r && wantsCreate) {   // criar sala: só PC, senha obrigatória
          if (m.kind !== 'pc') return err(ws, 'Só o PC cria salas', 'kind');
          if (String(m.pass ?? '').length < MIN_PASS) return err(ws, `Senha obrigatória (mínimo ${MIN_PASS} caracteres)`, 'pass');
          if (m.t === 'join' && !CODE_RE.test(code)) return err(ws, 'Código inválido');
          const want = m.t === 'join' ? code : (CODE_RE.test(String(m.room || '').toUpperCase()) ? String(m.room).toUpperCase() : '');
          if (want && rooms.has(want)) return err(ws, 'Sala ainda existe, tentando de novo…', 'exists');
          if (rooms.size >= MAX_ROOMS) return err(ws, 'Servidor cheio, tente mais tarde');
          if (hit('create:' + ws.ip, 60000) > 5) return err(ws, 'Muitas salas criadas, aguarde 1 minuto', 'blocked');
          const ice = await getIce();
          if (ws.room || ws.readyState !== 1 || (want && rooms.has(want))) return;
          return createRoom(ws, m, want, ice);
        }

        if (!r) { failed(ws.ip); return err(ws, 'Sala não encontrada', 'notfound'); }
        if (count('rf:' + code) >= 10) return err(ws, 'Muitas tentativas nesta sala. Aguarde 1 minuto.', 'blocked');
        if (!passOk(r, m.pass)) {
          failed(ws.ip); hit('rf:' + code, 60000);
          return err(ws, m.pass ? 'Senha incorreta' : 'Esta sala exige senha', 'pass');
        }
        if (r.members.size >= MAX_MEMBERS) return err(ws, 'Sala cheia', 'full');
        const ice = await getIce();
        if (ws.room || ws.readyState !== 1 || rooms.get(code) !== r) return;
        enterRoom(ws, r, code, m, ice);
      } else if (m.t === 'signal') {
        const r = rooms.get(ws.room), to = r && typeof m.to === 'string' && r.members.get(m.to);
        if (to && r.members.get(ws.id) === ws) tx(to, { t: 'signal', from: ws.id, data: m.data });
      } else if (m.t === 'sharing') {   // PC avisa que começou/parou de transmitir a tela
        const r = rooms.get(ws.room);
        if (r && ws.kind === 'pc' && r.members.get(ws.id) === ws) { ws.sharing = !!m.on; roster(r); }
      } else if (m.t === 'chat') {
        const r = rooms.get(ws.room);
        if (!r || r.members.get(ws.id) !== ws || typeof m.text !== 'string') return;
        const text = m.text.replace(/[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 500);
        if (!text || hit('chat:' + ws.id, 5000) > 8) return;
        const msg = { id: ++chatSeq, from: ws.id, nick: ws.nick, text, ts: Date.now() };
        r.chat.push(msg);
        if (r.chat.length > MAX_CHAT) r.chat.shift();
        r.members.forEach(p => tx(p, { t: 'chat', msg }));
      }
    } catch (e) { console.warn('erro na mensagem:', e.message); }
  });

  ws.on('close', () => {
    if (ws.hk && hotkeys.get(ws.hk) === ws) hotkeys.delete(ws.hk);
    const r = rooms.get(ws.room);
    if (!r || r.members.get(ws.id) !== ws) return;
    r.members.delete(ws.id);
    if (r.owner === ws) { const next = [...r.members.values()].find(p => p.kind === 'pc'); if (next) r.owner = next; }   // dono saiu: passa para outro PC
    if (![...r.members.values()].some(p => p.kind === 'pc')) {   // sem PC na sala não há o que assistir
      r.members.forEach(p => tx(p, { t: 'room-closed' }));
      rooms.delete(ws.room);
      return;
    }
    r.members.forEach(p => tx(p, { t: 'peer-left', id: ws.id }));
    roster(r);
  });
});

const heartbeat = setInterval(() => {   // derruba conexões mortas (celular sem sinal, aba suspensa)
  wss.clients.forEach(ws => {
    if (!ws.alive) return ws.terminate();
    ws.alive = false;
    try { ws.ping(); } catch {}
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

server.listen(PORT, '0.0.0.0', () => console.log(`Rodando em ${hasCert ? 'https' : 'http'}://0.0.0.0:${PORT}`));
