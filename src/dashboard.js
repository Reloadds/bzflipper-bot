// Self-contained localhost dashboard (like MBF / the mod's HUD) — zero deps, just
// Node's http. Serves a dark single-page UI at / that polls /api/state every 2s
// and renders status, purse/cookie, ranked flips, open orders, and a live log.

import http from 'node:http';

export function startDashboard({ port = 3000, getState, onConfig = null, onImport = null, onReport = null, log = () => {} }) {
  const server = http.createServer((req, res) => {
    try {
      if (req.method === 'POST' && req.url.startsWith('/api/report')) {
        try { const out = onReport ? onReport() : { ok: false, error: 'report not available' }; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
        catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/api/config')) {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy(); });
        req.on('end', () => {
          try {
            const applied = onConfig ? onConfig(JSON.parse(body || '{}')) : {};
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, applied }));
          } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/api/import')) {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy(); });
        req.on('end', () => {
          try {
            if (!onImport) throw new Error('import not available');
            const result = onImport(JSON.parse(body || '{}'));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ...result }));
          } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
      }
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
  .knobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px;padding:12px 14px}
  .knob{display:flex;flex-direction:column;gap:3px}
  .knob label{font-size:11px;color:var(--dim)}
  .knob input{background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 8px;font:13px ui-monospace,SFMono-Regular,Consolas,monospace}
  .save-row{padding:10px 14px;border-top:1px solid var(--line);display:flex;align-items:center;gap:12px}
  button{background:var(--acc);color:#04140a;border:none;border-radius:7px;padding:7px 14px;font-weight:700;cursor:pointer}
  button:hover{filter:brightness(1.1)}
  .imp{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:12px 14px}
  @media(max-width:820px){.imp{grid-template-columns:1fr}}
  .impcol{display:flex;flex-direction:column;gap:4px}
  .impcol label{font-size:11px;color:var(--dim)}
  .impcol textarea{background:#0a0d12;border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:8px;min-height:150px;resize:vertical;font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
  .filelbl{font-size:12px;color:var(--acc2);cursor:pointer}
  .filelbl:hover{text-decoration:underline}
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
    <div class="card"><div class="k">Coins / hr</div><div class="v" id="cph">—</div><div class="k" id="cphsub"></div></div>
    <div class="card"><div class="k">Session profit</div><div class="v" id="profit">—</div><div class="k" id="flips"></div></div>
    <div class="card"><div class="k">Margin gate <span id="autobadge" class="tag" style="display:none">AUTO</span></div><div class="v" id="mgate">—</div><div class="k" id="mgatesub"></div></div>
  </div>
  <div class="panel" style="margin-bottom:16px">
    <h2>Tuning — edit live <span id="saved" class="muted" style="text-transform:none;letter-spacing:0;font-weight:400"></span></h2>
    <div id="knobs" class="knobs"></div>
    <div class="save-row"><button id="save">Save &amp; apply</button><button id="report" style="background:var(--acc2)">Send breakdown → webhook</button><span class="muted" id="reportMsg">applies on the next tick and persists to config.json</span></div>
  </div>
  <div class="panel" style="margin-bottom:16px">
    <h2>Import config <span class="muted" style="text-transform:none;letter-spacing:0;font-weight:400">— paste an MBF-style settings JSON and/or a blacklist/whitelist JSON</span></h2>
    <div class="imp">
      <div class="impcol">
        <label>Settings JSON</label>
        <textarea id="impSettings" spellcheck="false" placeholder='{ "profit": { "minPercentage": 9, ... }, "orders": { "maxBuyOrders": 6 }, ... }'></textarea>
      </div>
      <div class="impcol">
        <label>Blacklist / Whitelist JSON — old MBF format OR a v2 filters.rules.json</label>
        <textarea id="impFilters" spellcheck="false" placeholder='{ "blacklist": ["ENCHANTED_COAL", ...], "whitelist": { "PRECURSOR_GEAR": { "minProfit": 50000 } } }  — or paste a full v2 rules file'></textarea>
      </div>
    </div>
    <div class="save-row">
      <button id="impBtn">Import &amp; apply</button>
      <label class="filelbl">Load file… <input id="impFile" type="file" accept="application/json,.json" hidden></label>
      <span class="muted" id="impMsg">blacklist/whitelist use Bazaar product IDs (e.g. ENCHANTED_COAL). Applies live + persists.</span>
    </div>
  </div>
  <div class="grid2">
    <div class="panel"><h2>Top flips (coins/hr)</h2><div id="flipsWrap"></div></div>
    <div class="panel"><h2>Open orders</h2><div id="ordersWrap"></div></div>
  </div>
  <div id="log"></div>
</main>
<script>
const $=id=>document.getElementById(id);
const KNOBS=[['apiMinMargin','Min margin (frac)',0.005],['apiMaxMargin','Max margin (frac)',0.01],['apiMinWeeklyVolume','Min weekly volume',10000],['minEfficiency','Min efficiency',0.05],['orderLimit','Order slots',1],['orderBudgetFraction','Budget fraction',0.05],['coinReserve','Coin reserve',1000000],['minOrderValue','Min order value',50000],['autoMarginMaxBonus','Auto-margin max +',0.005],['minProfitCoins','Min profit / order',1000],['maxProfitCoins','Max profit / order',1000000],['maxSpentPerOrder','Max spent / order',1000000],['apiMaxUnitPrice','Max unit price (buy)',1000000],['minUnitPrice','Min unit price',100],['maxSellUnitPrice','Max unit price (sell)',1000000],['minBuyVolumeHourly','Min buy vol/hr',10],['minSellVolumeHourly','Min sell vol/hr',10],['apiMaxTopGap','Manip. top-gap (frac)',0.01],['relistCooldownSeconds','Relist cooldown (s)',5],['maxRelistsPerOrder','Max relists',1],['blacklistMinutes','Bench minutes',5],['buyStallMinutes','Buy stall (min)',1]];
let knobsBuilt=false;
function syncKnobs(cfg){if(!cfg)return;
  if(!knobsBuilt){$('knobs').innerHTML=KNOBS.map(([k,l,s])=>'<div class="knob"><label>'+l+'</label><input data-k="'+k+'" type="number" step="'+s+'" value="'+(cfg[k]??'')+'"></div>').join('');knobsBuilt=true;return;}
  for(const [k] of KNOBS){const el=document.querySelector('input[data-k="'+k+'"]');if(el&&document.activeElement!==el)el.value=cfg[k];}}
async function saveKnobs(){const patch={};document.querySelectorAll('#knobs input').forEach(el=>{const v=parseFloat(el.value);if(!isNaN(v))patch[el.dataset.k]=v});
  try{const r=await (await fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(patch)})).json();
    $('saved').textContent=r.ok?('✓ saved '+Object.keys(r.applied).length+' at '+new Date().toLocaleTimeString()):('✗ '+r.error);}
  catch(e){$('saved').textContent='✗ '+e.message;}}
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
  const cph=s.coinsPerHour;
  $('cph').textContent=cph==null?'—':fmt(cph)+'/hr';
  $('cph').style.color=cph==null?'':(cph>=12e6?'var(--acc)':cph>=6e6?'var(--warn)':'var(--bad)');
  $('cphsub').textContent=cph==null?'warming up…':(cph>=12e6?'✓ ≥ 12M target':'target 12M/hr');
  $('mgate').textContent=s.effectiveMargin==null?'—':(s.effectiveMargin*100).toFixed(1)+'%';
  $('autobadge').style.display=s.autoMargin?'':'none';
  $('mgatesub').textContent=(s.marginBonus>0)?('+'+(s.marginBonus*100).toFixed(1)+'% adaptive'):(s.autoMargin?'at floor':'');
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
  syncKnobs(s.config);
}
$('save').onclick=saveKnobs;
$('report').onclick=async()=>{$('reportMsg').textContent='sending…';try{const r=await(await fetch('/api/report',{method:'POST'})).json();$('reportMsg').textContent=r.ok?'breakdown sent to webhook + printed in console ✓':'report failed: '+(r.error||'?');}catch(e){$('reportMsg').textContent='report failed';}setTimeout(()=>{$('reportMsg').textContent='applies on the next tick and persists to config.json';},6000);};
async function doImport(){
  const st=$('impSettings').value.trim(), fl=$('impFilters').value.trim();
  if(!st&&!fl){$('impMsg').textContent='paste a settings and/or blacklist JSON first';return;}
  let payload={};
  try{ if(st)payload.settings=JSON.parse(st); if(fl)payload.filters=JSON.parse(fl); }
  catch(e){$('impMsg').textContent='✗ invalid JSON: '+e.message;return;}
  try{const r=await (await fetch('/api/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json();
    if(!r.ok){$('impMsg').textContent='✗ '+r.error;return;}
    const keys=Object.keys(r.applied||{});
    $('impMsg').textContent='✓ imported '+keys.length+' field'+(keys.length===1?'':'s')+(r.warnings&&r.warnings.length?(' · '+r.warnings.length+' warning(s): '+r.warnings.join(' | ')):'')+' — '+new Date().toLocaleTimeString();
    knobsBuilt=false; // rebuild knobs to reflect imported values
  }catch(e){$('impMsg').textContent='✗ '+e.message;}}
$('impBtn').onclick=doImport;
$('impFile').onchange=e=>{const f=e.target.files[0];if(!f)return;const rd=new FileReader();
  rd.onload=()=>{let o;try{o=JSON.parse(rd.result);}catch(err){$('impMsg').textContent='✗ file not valid JSON';return;}
    const isFilters=Array.isArray(o.blacklist)||o.whitelist;
    (isFilters?$('impFilters'):$('impSettings')).value=JSON.stringify(o,null,2);
    $('impMsg').textContent='loaded '+f.name+' into '+(isFilters?'blacklist/whitelist':'settings')+' — click Import';};
  rd.readAsText(f);e.target.value='';};
tick(); setInterval(tick,2000);
</script></body></html>`;
