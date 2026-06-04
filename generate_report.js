// generate_report.js
// Queries Supabase REST API directly (no WebSocket needed) and generates
// the weekly usage report HTML. Run by GitHub Actions.

const fs = require('fs');
const https = require('https');

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  process.exit(1);
}

// ── Simple REST fetch helper ───────────────────────────────────────────────
function supabaseFetch(table, params) {
  return new Promise((resolve, reject) => {
    const query = params ? '?' + params : '';
    const url = new URL(`/rest/v1/${table}${query}`, SUPABASE_URL);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept': 'application/json'
      }
    };
    https.get(options, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error: ' + body)); }
      });
    }).on('error', reject);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function fmtDate(ds) {
  const [y,m,d] = ds.split('-');
  return `${m}/${d}/${y}`;
}
function fmtMin(m) {
  const h = Math.floor(m/60), mn = m%60;
  return h > 0 ? (mn > 0 ? `${h}h ${mn}m` : `${h}h`) : `${mn}m`;
}
function slotToLabel(s) {
  const h = Math.floor(s/2), m = s%2===0?'00':'30';
  const ampm = h < 12 ? 'AM' : 'PM';
  const h12  = h === 0 ? 12 : h > 12 ? h-12 : h;
  return `${h12}:${m} ${ampm}`;
}
function bookingKey(ds, slot) { return `${ds}_${slot}`; }
function normName(raw) {
  if (!raw) return '';
  return raw.trim()
    .split(' ')
    .map(word => word.split('-').map(seg =>
      seg.split('/').map(s => s ? s.charAt(0).toUpperCase()+s.slice(1).toLowerCase() : '').join('/')
    ).join('-'))
    .join(' ');
}
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Build report data ──────────────────────────────────────────────────────
function buildReportData(bookingsMap, blocksList, from, to) {
  const fromD = new Date(from+'T00:00:00');
  const toD   = new Date(to+'T23:59:59');
  const dates = [];
  for (let d = new Date(fromD); d <= toD; d.setDate(d.getDate()+1))
    dates.push(dateKey(new Date(d)));

  const weeks = {};
  const getWeekKey = ds => {
    const d = new Date(ds+'T12:00:00');
    const sun = new Date(d); sun.setDate(d.getDate()-d.getDay());
    return dateKey(sun);
  };

  let totalBookingMin=0, totalBlockMin=0;
  const bookingSummary=[], blockSummary=[];
  const seenCk = new Set();

  for (const dateStr of dates) {
    const wk = getWeekKey(dateStr);
    if (!weeks[wk]) weeks[wk] = {bookingMin:0, blockMin:0};

    for (let s=0; s<48; s++) {
      const b = bookingsMap[bookingKey(dateStr,s)];
      if (!b) continue;
      const cid = b.cluster_key || bookingKey(dateStr,s);
      if (seenCk.has(cid)) continue;
      seenCk.add(cid);
      const st = b.cluster_start != null ? b.cluster_start : s;
      const en = b.cluster_end   != null ? b.cluster_end   : s;
      const mins = (en-st+1)*30;
      bookingSummary.push({
        date:dateStr, name:b.name, pi:normName(b.pi),
        start:slotToLabel(st), end:slotToLabel(en+1), minutes:mins
      });
      weeks[wk].bookingMin += mins;
      totalBookingMin += mins;
    }

    const dayBlocks = blocksList.filter(bl => bl.date_str === dateStr);
    for (const bl of dayBlocks) {
      const [sh,sm] = bl.start_time.split(':').map(Number);
      const [eh,em] = bl.end_time.split(':').map(Number);
      const mins = (eh*60+em)-(sh*60+sm);
      blockSummary.push({
        date:dateStr, start:bl.start_time,
        end:bl.end_time, reason:bl.reason||'Blocked', minutes:mins
      });
      weeks[wk].blockMin += mins;
      totalBlockMin += mins;
    }
  }

  const byPI = {};
  for (const b of bookingSummary) {
    if (!byPI[b.pi]) byPI[b.pi] = {totalMin:0, bookings:[]};
    byPI[b.pi].totalMin += b.minutes;
    byPI[b.pi].bookings.push(b);
  }

  return {weeks, bookingSummary, blockSummary, totalBookingMin, totalBlockMin, from, to, byPI};
}

// ── Generate HTML ──────────────────────────────────────────────────────────
function generateHTML(data) {
  const {weeks, bookingSummary, blockSummary, totalBookingMin, totalBlockMin, byPI, from, to} = data;

  const wkRows = Object.entries(weeks).sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([wk,w])=>`<tr><td>Week of ${fmtDate(wk)}</td><td>${fmtMin(w.bookingMin)}</td><td>${fmtMin(w.blockMin)}</td></tr>`).join('');

  const bkRows = bookingSummary.map(b=>
    `<tr><td>${fmtDate(b.date)}</td><td>${escHtml(b.name)}</td><td>${escHtml(b.pi)}</td><td>${b.start} – ${b.end}</td><td>${b.minutes} min</td></tr>`
  ).join('');

  const blRows = blockSummary.map(b=>
    `<tr><td>${fmtDate(b.date)}</td><td>${b.start} – ${b.end}</td><td>${escHtml(b.reason)}</td><td>${b.minutes} min</td></tr>`
  ).join('');

  const piRows = Object.entries(byPI).sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([pi,grp])=>`<tr><td>${escHtml(pi)}</td><td>${grp.bookings.length}</td><td>${fmtMin(grp.totalMin)}</td></tr>`).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Flow Cytometer Report ${from} – ${to}</title>
<link href='https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap' rel='stylesheet'>
<style>
body{font-family:'Google Sans','Segoe UI',Arial,sans-serif;background:#f5f0eb;color:#2b2318;padding:40px;max-width:960px;margin:auto;}
h1{color:#3E4C54;font-size:1.8rem;margin-bottom:4px;}
h2{color:#BC6C54;font-size:1.1rem;margin:28px 0 10px;}
.period{color:#6a7a84;font-size:.9rem;margin-bottom:24px;}
table{width:100%;border-collapse:collapse;margin-bottom:20px;font-size:.9rem;}
th{background:#3E4C54;color:#E9D9C8;padding:10px 14px;text-align:left;}
th.sortable{cursor:pointer;user-select:none;}
th.sortable:hover{background:#4a6070;}
th.sort-asc::after{content:' ▲';font-size:.7rem;}
th.sort-desc::after{content:' ▼';font-size:.7rem;}
td{padding:9px 14px;border-bottom:1px solid #d8cfc4;}
tr:hover td{background:#ede8e2;}
.totals{background:#3E4C54;color:#E9D9C8;padding:20px 24px;border-radius:10px;display:flex;gap:40px;flex-wrap:wrap;margin-bottom:8px;}
.total-item{text-align:center;}
.total-item .val{font-size:1.8rem;font-weight:700;color:#E4A489;}
.total-item .lbl{font-size:.8rem;opacity:.8;}
@media print{body{padding:20px;background:white;}}
</style></head><body>
<h1>Flow Cytometer Usage Report</h1>
<div class="period">HANS 301 &nbsp;·&nbsp; ${fmtDate(from)} to ${fmtDate(to)} &nbsp;·&nbsp; Generated ${new Date().toLocaleString()}</div>
<div class="totals">
  <div class="total-item"><div class="val">${fmtMin(totalBookingMin)}</div><div class="lbl">Total Booking Time</div></div>
  <div class="total-item"><div class="val">${fmtMin(totalBlockMin)}</div><div class="lbl">Total Block/Maintenance Time</div></div>
  <div class="total-item"><div class="val">${bookingSummary.length}</div><div class="lbl">Total Bookings</div></div>
  <div class="total-item"><div class="val">${Object.keys(byPI).length}</div><div class="lbl">PI Labs</div></div>
</div>
<h2>Usage by PI / Lab</h2>
<table><thead><tr><th>PI / Lab</th><th>Bookings</th><th>Total Time</th></tr></thead>
<tbody>${piRows||'<tr><td colspan="3" style="color:#999">No bookings in this period.</td></tr>'}</tbody></table>
<h2>Weekly Summary</h2>
<table><thead><tr><th>Week</th><th>Booking Time</th><th>Block/Maintenance Time</th></tr></thead>
<tbody>${wkRows||'<tr><td colspan="3" style="color:#999">No data.</td></tr>'}</tbody></table>
<h2>All Bookings</h2>
<table id="bookingsTable"><thead><tr>
  <th class="sortable" data-col="0" data-type="date">Date</th>
  <th class="sortable" data-col="1" data-type="str">Name</th>
  <th class="sortable" data-col="2" data-type="str">PI / Lab</th>
  <th class="sortable" data-col="3" data-type="time">Time</th>
  <th class="sortable" data-col="4" data-type="num">Duration</th>
</tr></thead>
<tbody>${bkRows||'<tr><td colspan="5" style="color:#999">No bookings in this period.</td></tr>'}</tbody></table>
<h2>Maintenance / Blocked Periods</h2>
<table><thead><tr><th>Date</th><th>Time</th><th>Reason</th><th>Duration</th></tr></thead>
<tbody>${blRows||'<tr><td colspan="4" style="color:#999">No blocks in this period.</td></tr>'}</tbody></table>
<script>
(function(){
  const table=document.getElementById('bookingsTable');
  if(!table)return;
  let sc=-1,sd=1;
  table.querySelectorAll('th.sortable').forEach(th=>th.addEventListener('click',()=>{
    const col=+th.dataset.col,type=th.dataset.type;
    if(sc===col)sd*=-1;else{sc=col;sd=1;}
    table.querySelectorAll('th').forEach(h=>h.classList.remove('sort-asc','sort-desc'));
    th.classList.add(sd===1?'sort-asc':'sort-desc');
    const tbody=table.querySelector('tbody');
    [...tbody.querySelectorAll('tr')].filter(r=>r.cells.length>1).sort((a,b)=>{
      let av=a.cells[col]?.textContent.trim()||'',bv=b.cells[col]?.textContent.trim()||'';
      if(type==='date'){av=av.split('/').reverse().join('');bv=bv.split('/').reverse().join('');}
      else if(type==='num')return(parseFloat(av)-parseFloat(bv))*sd;
      else if(type==='time'){const f=s=>{const m=s.match(/(\d+):(\d+)\s*(am|pm)/i);if(!m)return 0;let h=+m[1];const p=m[3].toLowerCase();if(p==='pm'&&h!==12)h+=12;if(p==='am'&&h===12)h=0;return h*60+ +m[2];};return(f(av)-f(bv))*sd;}
      return av.localeCompare(bv)*sd;
    }).forEach(r=>tbody.appendChild(r));
  }));
})();
<\/script>
</body></html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const today  = new Date();
  // Find Sunday of the PREVIOUS week (week runs Sun → Sat)
  const day = today.getDay(); // 0=Sun, 1=Mon ... 6=Sat
  const thisSunday = new Date(today); thisSunday.setDate(today.getDate() - day);
  const lastSunday = new Date(thisSunday); lastSunday.setDate(thisSunday.getDate() - 7);
  const lastSaturday = new Date(lastSunday); lastSaturday.setDate(lastSunday.getDate() + 6);
  const from = dateKey(lastSunday);
  const to   = dateKey(lastSaturday);

  console.log(`Fetching bookings and blocks for ${from} → ${to} …`);

  // Use Supabase REST API with date range filters
  const [bookings, blocks] = await Promise.all([
    supabaseFetch('bookings', `date_str=gte.${from}&date_str=lte.${to}&select=*`),
    supabaseFetch('blocks',   `date_str=gte.${from}&date_str=lte.${to}&select=*`)
  ]);

  if (!Array.isArray(bookings)) { console.error('Bookings error:', bookings); process.exit(1); }
  if (!Array.isArray(blocks))   { console.error('Blocks error:',   blocks);   process.exit(1); }

  const bookingsMap = {};
  for (const row of bookings) bookingsMap[bookingKey(row.date_str, row.slot)] = row;

  const data = buildReportData(bookingsMap, blocks, from, to);
  const html = generateHTML(data);

  const filename = `flow-cytometer-report-${from}-${to}.html`;
  fs.writeFileSync(filename, html, 'utf8');
  console.log(`✓ Report written: ${filename}`);
  console.log(`  Bookings: ${data.bookingSummary.length}`);
  console.log(`  Blocks:   ${data.blockSummary.length}`);
  console.log(`  PI labs:  ${Object.keys(data.byPI).length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
