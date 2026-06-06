// ============================================================
//  home.js — RSR Engineering admin dashboard (the start page)
//  PIN-gated. Shows live summaries; links into each module.
// ============================================================
import { html, render } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { supabase } from './supabase.js';

const SESSION_KEY = 'rsr_admin';          // shared unlock flag for this browser session
const PIN_KEY = 'rsr_admin_pin';          // changeable PIN (default 1234)

// count helper — returns a number, or null if the table/column isn't ready
async function countRows(table, build) {
  try {
    let q = supabase.from(table).select('*', { count: 'exact', head: true });
    if (build) q = build(q);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  } catch (_) { return null; }
}

function Field({ label, children }) {
  return html`<div class="field"><label>${label}</label>${children}</div>`;
}

function Lock({ onUnlock, toast }) {
  const [pin, setPin] = useState('');
  const tryUnlock = () => {
    const admin = localStorage.getItem(PIN_KEY) || '1234';
    if (pin === admin) { sessionStorage.setItem(SESSION_KEY, '1'); onUnlock(); }
    else toast('Wrong PIN');
  };
  return html`
    <div class="wrap">
      <div class="card lock">
        <div class="brand" style="justify-content:center;margin-bottom:6px"><b>RSR</b><span class="tag">ENGINEERING</span></div>
        <p class="note" style="margin:0 0 14px">Admin dashboard</p>
        <${Field} label="Enter admin PIN">
          <input type="password" inputmode="numeric" value=${pin}
            onInput=${e => setPin(e.target.value)} placeholder="default 1234"
            onKeyDown=${e => { if (e.key === 'Enter') tryUnlock(); }} />
        <//>
        <button class="btn" onClick=${tryUnlock}>Unlock</button>
      </div>
    </div>`;
}

function Tile({ ico, num, unit, title, href }) {
  const inner = html`
    <div class="ico">${ico}</div>
    <div class=${'num' + (num == null ? ' dim' : '')}>${num == null ? '—' : num}</div>
    <h3>${title}</h3>
    <div class="unit">${unit}</div>`;
  return href
    ? html`<a class="tile" href=${href}>${inner}</a>`
    : html`<div class="tile soon">${ico ? html`<div class="ico">${ico}</div>` : ''}<h3 style="margin-top:8px">${title}</h3><span class="badge">COMING SOON</span></div>`;
}

function App() {
  const [authed, setAuthed] = useState(sessionStorage.getItem(SESSION_KEY) === '1');
  const [m, setM] = useState({});
  const [toast, setToast] = useState(null);
  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2400); };

  useEffect(() => {
    if (!authed) return;
    const iso30 = new Date(Date.now() - 30 * 864e5).toISOString();
    (async () => {
      const [toolsOut, inRepair, issued30, vessels, people] = await Promise.all([
        countRows('borrow_issuance', q => q.eq('txn_type', 'borrow').eq('status', 'out')),
        countRows('item_units', q => q.eq('active', true).eq('status', 'repair')),
        countRows('borrow_issuance', q => q.eq('txn_type', 'issuance').gte('borrowed_at', iso30)),
        countRows('voyages', q => q.neq('status', 'not_active')),
        countRows('employees', q => q.eq('active', true)),
      ]);
      setM({ toolsOut, inRepair, issued30, vessels, people });
    })();
  }, [authed]);

  if (!authed) return html`<${Lock} onUnlock=${() => setAuthed(true)} toast=${flash} />
    ${toast && html`<div class="toast">${toast}</div>`}`;

  const live = [
    { ico:'🔧', num:m.toolsOut,  unit:'out now',        title:'Tool Borrowing',   href:'./borrower-equipments/' },
    { ico:'📦', num:m.issued30,  unit:'issued (30 days)', title:'Material Issuance', href:'./borrower-equipments/' },
    { ico:'🛠️', num:m.inRepair,  unit:'in repair',       title:'Tool Repair',      href:'./borrower-equipments/' },
    { ico:'🚢', num:m.vessels,   unit:'active',          title:'Vessel Schedule',  href:'./coordinator/' },
    { ico:'👷', num:m.people,    unit:'on file',         title:'Personnel',        href:'./coordinator/' },
  ];
  const soon = [
    { ico:'⏱️', title:'Time In / Out' },
    { ico:'📝', title:'Leave Approval' },
    { ico:'📊', title:'Project Status' },
    { ico:'💰', title:'Cash Advance / Payroll' },
  ];

  return html`
    <header class="app">
      <div class="wrap"><div class="brand" style="justify-content:space-between;display:flex;align-items:center">
        <span><b>RSR</b><span class="tag">ENGINEERING</span></span>
        <button onClick=${() => { sessionStorage.removeItem(SESSION_KEY); setAuthed(false); }}
          style="background:none;border:none;color:var(--ink-dim);font-size:13px;font-weight:700;cursor:pointer">lock</button>
      </div></div>
    </header>
    <div class="wrap">
      <div class="sectlabel">Live overview</div>
      <div class="grid">
        ${live.map(t => html`<${Tile} ...${t} />`)}
      </div>

      <div class="sectlabel">On the roadmap</div>
      <div class="grid">
        ${soon.map(t => html`<${Tile} ...${t} />`)}
      </div>

      <p class="note" style="text-align:center;margin-top:6px">RSR Engineering Services · Cebu</p>
    </div>
    ${toast && html`<div class="toast">${toast}</div>`}
  `;
}

render(html`<${App} />`, document.getElementById('app'));
