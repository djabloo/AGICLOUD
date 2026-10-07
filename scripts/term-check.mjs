// Prova del terminale lato server: crea, collega, comando, riconnessione con replay, controlli di sicurezza.
//   TOKEN=... node scripts/term-check.mjs http://127.0.0.1:3096 "" <cwd>
import WebSocket from 'ws';

const [base = 'http://127.0.0.1:3096', argToken = '', cwd = '/tmp'] = process.argv.slice(2);
const token = process.env.TOKEN ?? argToken;
const auth = token ? { authorization: `Bearer ${token}` } : {};
const wsUrl = (id) => base.replace(/^http/, 'ws') + `/api/terminals/${id}/ws`;
const res = await fetch(`${base}/api/terminals`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ cwd }),
});
const term = await res.json();
console.log('creato', res.status, term.title, term.cwd);

function connect(origin, tok = token) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl(term.id), { headers: origin ? { origin } : {} });
    let out = '';
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: tok, cols: 80, rows: 24 })));
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === 'replay' || msg.type === 'data') out += msg.data;
    });
    ws.on('unexpected-response', (_req, r) => resolve({ rejected: r.statusCode }));
    ws.on('close', (code) => resolve({ closed: code, out }));
    ws.on('error', () => {});
    resolve.ws = ws;
    setTimeout(() => resolve({ ws, get out() { return out; } }), 1200);
  });
}

const origin = base;
const a = await connect(origin);
a.ws.send(JSON.stringify({ type: 'input', data: 'echo MARCA-$((40+2)) && pwd && echo SIZE=$(stty size)\r' }));
await new Promise((r) => setTimeout(r, 800));
console.log('output contiene MARCA-42:', a.out.includes('MARCA-42'), '| cwd giusta:', a.out.includes(cwd), '| misure al via (atteso 24 80):', (a.out.match(/SIZE=(\d+ \d+)/) ?? [])[1]);
a.ws.close();

const b = await connect(origin);
console.log('replay dopo riconnessione contiene MARCA-42:', b.out.includes('MARCA-42'));
b.ws.close();

console.log('senza Origin:', await connect(undefined));
console.log('Origin di un altro sito:', await connect('https://evil.example'));
if (token) {
  const bad = await connect(origin, 'sbagliato');
  console.log('token sbagliato -> chiuso con', bad.closed ?? bad);
}

await fetch(`${base}/api/terminals/${term.id}`, { method: 'DELETE', headers: auth });
console.log('lista dopo chiusura:', await (await fetch(`${base}/api/terminals`, { headers: auth })).json());
process.exit(0);
