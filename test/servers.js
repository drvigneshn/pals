// Local stand-ins for testing without internet:
//   MQTT-over-WebSocket broker on :8888 (instead of the public relays) and a static server for the app on :8080.
// Run from test/:  npm install && node servers.js
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer, createWebSocketStream } = require('ws');
const aedes = require('aedes')();
const wss = new WebSocketServer({ port: 8888 });
wss.on('connection', ws => aedes.handle(createWebSocketStream(ws)));
const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(8080, () => console.log('app http://127.0.0.1:8080  broker ws://127.0.0.1:8888'));
