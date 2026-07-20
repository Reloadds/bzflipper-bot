// Self-contained localhost dashboard (like MBF / the mod's HUD) — zero deps, just
// Node's http. Serves a dark single-page UI at / that polls /api/state every 2s
// and renders status, purse/cookie, ranked flips, open orders, and a live log.

import http from 'node:http';

export function startDashboard({ port = 3000, getState, log = () => {} }) {
  const server = http.createServer((req, res) => {
    try {
      if (req.url.startsWith('/api/state')) {
        const body = JSON.stringify(getState());
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(body);
      }
      if (req.url === '/' || req.url.startsWith('/index')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end(String(e?.message || e));
    }
  });
  server.on('error', (e) => log(`dashboard: cannot bind port ${port} — ${e.message}`));
  server.listen(port, () => log(`\x1b[36mdashboard: http://localhost:${port}\x1b[0m  (remote box? tunnel: ssh -L ${port}:localhost:${port} user@host)`));
  return server;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bzflipper-bot</title>
<style>
  :root{--bg:#0e1116;--panel:#171b22;--panel2:#1e242d;--line:#2a313c;--fg:#e6edf3;--dim:#8b98a6;--acc:#3fb950;--acc2:#58a6ff;--warn:#d29922;--bad:#f85149}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 18px;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
  header h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.3px}
  .pill{padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line)}
  .pill.on{color:var(--acc);border-color:#1f6f34;background:#0f2a17}
  .pill.off{color:var(--bad);border-color:#5a1f1c;background:#2a1110}
  .pill.live{color:var(--warn);border-color:#5a4410;background:#2a2110}
  .pill.observe{color:var(--acc2);border-color:#1f477a;background:#0f2036}
  .spacer{flex:1}
  .muted{color:var(--dim)}
  main{padding:16px;max-width:1200px;margin:0 auto}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:16px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .card .k{font-size:12px;color:var(--dim);text-transform:uppercase;letter-spacing:.4px}
  .card .v{font-size:22px;font-weight:700;margin-top:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  @media(max-width:820px){.grid2{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .panel h2{margin:0;font-size:13px;padding:10px 14px;border-bottom:1px solid var(--line);color:var(--dim);text-transform:uppercase;letter-spacing:.4px;font-weight:700}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 14px;border-bottom:1px solid var(--panel2);white-space:nowrap}
  th{color:var(--dim);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.3px}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  tr:last-child td{border-bottom:none}
  .tag{font-size:10px;padding:1px 6px;border-radius:5px;background:var(--panel2);color:var(--dim)}
  .tag.claim{color:var(--acc);background:#0f2a17}
  .buy{color:var(--acc2)}.sell{color:var(--acc)}
  .bar{height:5px;background:var(--panel2);border-radius:3px;overflow:hidden;min-width:60px}
  .bar>i{display:block;height:100%;background:var(--acc)}
  #log{background:#0a0d12;border:1px solid var(--line);border-radius:10px;margin-top:16px;padding:10px 12px;height:260px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;color:#c9d1d9;white-space:pre-wrap}
  #log .l{color:var(--dim)}
  .empty{padding:16px 14px;color:var(--dim)}
  a{color:var(--acc2)}
</style></head><body>
<header>
  <h1>⚡ bzflipper-bot</h1>
  <span id="status" class="pill off">…</span>
  <span id="mode" class="pill observe">…</span>
  <span class="muted" id="user"></span>
  <div class="spacer"></div>
  <span class="muted" id="uptime"></span>
  <span class="muted">·</span>
  <span class="muted" id="apiage"></span>
</header>
<main>
  <div class="cards">
    <div class="card"><div class="k">Purse</div><div class="v" id="purse">—</div></div>
    <div class="card"><div class="k">Cookie</div><div class="v" id="cookie">—</div></div>
    <div class="card"><div class="k">Open orders</div><div class="v" id="ordn">—</div></div>
    <div class="card"><div class="k">Session profit</div><div class="v" id="profit">—</div><div class="k" id="flips"></div></div>
  </div>
  <div class="grid2">
    <div class="panel"><h2>Top flips (coins/hr)</h2><div id="flipsWrap"></div></div>
    <div class="panel"><h2>Open orders</h2><div id="ordersWrap"></div></div>
  </div>
  <div id="log"></div>
</main>
<script>
const $=id=>document.getElementById(id);
const fmt=v=>{if(v==null||isNaN(v))return '—';const a=Math.abs(v);if(a>=1e9)return (v/1e9).toFixed(2)+'B';if(a>=1e6)return (v/1e6).toFixed(2)+'M';if(a>=1e3)return (v/1e3).toFixed(1)+'k';return Math.round(v)};
const dur=s=>{s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+'h '+m+'m':m+'m '+(s%60)+'s'};
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function tick(){
  let s; try{ s=await (await fetch('/api/state',{cache:'no-store'})).json(); }catch(e){ $('status').className='pill off'; $('status').textContent='offline'; return; }
  const on=s.status&&!/disconn|starting|error/i.test(s.status);
  $('status').className='pill '+(on?'on':'off'); $('status').textContent=s.status||'—';
  $('mode').className='pill '+(s.mode==='LIVE'?'live':'observe'); $('mode').textContent=s.mode||'—';
  $('user').textContent=s.username||''; $('uptime').textContent='up '+dur(s.uptimeSec||0);
  $('apiage').textContent='api '+(s.apiAgeSec==null?'—':Math.round(s.apiAgeSec)+'s');
  $('purse').textContent=fmt(s.purse); $('cookie').textContent=s.cookieH==null?'—':(s.cookieH<0?'?':s.cookieH+'h');
  $('ordn').textContent=s.orders?s.orders.length:0;
  $('profit').textContent=(s.session&&s.session.profit!=null)?fmt(s.session.profit):'—';
  $('flips').textContent=s.session?((s.session.flips||0)+' flips'):'';
  // flips
  const fw=$('flipsWrap');
  if(!s.flips||!s.flips.length){fw.innerHTML='<div class="empty">no ranked flips yet…</div>';}
  else{let h='<table><tr><th>#</th><th>Item</th><th class="num">coins/hr</th><th class="num">margin</th><th class="num">vel/hr</th></tr>';
    s.flips.forEach((f,i)=>{h+='<tr><td class="muted">'+(i+1)+'</td><td>'+esc(f.name)+'</td><td class="num">'+fmt(f.cph)+'</td><td class="num">'+(f.margin*100).toFixed(1)+'%</td><td class="num">'+fmt(f.velocity)+'</td></tr>';});
    fw.innerHTML=h+'</table>';}
  // orders
  const ow=$('ordersWrap');
  if(!s.orders||!s.orders.length){ow.innerHTML='<div class="empty">no open orders</div>';}
  else{let h='<table><tr><th>Side</th><th>Item</th><th class="num">price</th><th class="num">amt</th><th>fill</th></tr>';
    s.orders.forEach(o=>{const cls=o.side==='buy'?'buy':'sell';h+='<tr><td class="'+cls+'">'+o.side.toUpperCase()+'</td><td>'+esc(o.item)+'</td><td class="num">'+fmt(o.price)+'</td><td class="num">'+fmt(o.amount)+'</td><td><div class="bar"><i style="width:'+Math.min(100,o.filledPct||0)+'%"></i></div><span class="muted" style="font-size:11px">'+Math.round(o.filledPct||0)+'%</span>'+(o.claimable?' <span class="tag claim">claim</span>':'')+'</td></tr>';});
    ow.innerHTML=h+'</table>';}
  // log
  const lg=$('log'), atBottom=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-30;
  lg.innerHTML=(s.logs||[]).map(l=>'<div><span class="l">'+esc(l.t)+'</span> '+esc(l.line)+'</div>').join('');
  if(atBottom)lg.scrollTop=lg.scrollHeight;
}
tick(); setInterval(tick,2000);
</script></body></html>`;
