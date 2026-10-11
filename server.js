const fs = require('fs'), path = require('path'), http = require('http'), https = require('https');
const express = require('express');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const nsRoot = path.join(__dirname, 'node_modules/@sapphi-red/web-noise-suppressor');
const listAll = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(f => f.isDirectory() ? listAll(path.join(d, f.name)) : [path.join(d, f.name)]);
try {   // RNNoise (IA de supressão de ruído): acha os arquivos onde quer que a biblioteca os coloque
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
  console.log('Arquivos rnnoise no pacote:', all.filter(f => /rnnoise/i.test(f)).map(f => path.relative(nsRoot, f)));
  const entryPath = path.join(nsRoot, entry);
  app.get('/ns/index.js', (req, res) => res.sendFile(entryPath));
  for (const n of ['rnnoiseWorklet.js', 'rnnoise.wasm', 'rnnoise_simd.wasm']) {
    const f = resolve(n);
    console.log('RNNoise', n, f ? 'ok' : 'NAO ENCONTRADO');
    if (f) { app.get('/ns/' + n, (req, res) => res.sendFile(f)); if (n.endsWith('.js')) app.use('/ns', express.static(path.dirname(f))); }
  }
  app.use('/ns', express.static(path.dirname(entryPath)));
  app.get('/ns-debug', (req, res) => res.json({ entryPath, files: all }));
} catch (e) { console.warn('RNNoise não encontrado (rode npm install):', e.message); }

const PORT = process.env.PORT || 3000;
const hasCert = fs.existsSync('key.pem') && fs.existsSync('cert.pem');
const server = hasCert
  ? https.createServer({ key: fs.readFileSync('key.pem'), cert: fs.readFileSync('cert.pem') }, app)
  : http.createServer(app);

const wss = new WebSocketServer({ server });
const rooms = new Map(); // id -> { host, members: Map(id -> ws) }
let uid = 0;
const tx = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

wss.on('connection', ws => {
  ws.id = String(++uid);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'create') {
      let id; do { id = String(10000 + Math.floor(Math.random() * 90000)); } while (rooms.has(id));
      rooms.set(id, { host: ws, members: new Map([[ws.id, ws]]) });
      ws.room = id;
      tx(ws, { t: 'created', room: id, me: ws.id });
    } else if (m.t === 'join') {
      const r = rooms.get(String(m.room));
      if (!r) return tx(ws, { t: 'error', msg: 'Sala não encontrada' });
      ws.room = String(m.room);
      const existing = [...r.members.keys()];
      r.members.set(ws.id, ws);
      tx(ws, { t: 'joined', me: ws.id, host: r.host.id, peers: existing });
      r.members.forEach((p, id) => id !== ws.id && tx(p, { t: 'peer-joined', id: ws.id }));
    } else if (m.t === 'signal') {
      const r = rooms.get(ws.room), to = r && r.members.get(m.to);
      if (to) tx(to, { t: 'signal', from: ws.id, data: m.data });
    }
  });
  ws.on('close', () => {
    const r = rooms.get(ws.room);
    if (!r) return;
    if (r.host === ws) {
      r.members.forEach(p => p !== ws && tx(p, { t: 'room-closed' }));
      rooms.delete(ws.room);
    } else {
      r.members.delete(ws.id);
      r.members.forEach(p => tx(p, { t: 'peer-left', id: ws.id }));
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Rodando em ${hasCert ? 'https' : 'http'}://0.0.0.0:${PORT}`));
