// ============================================================
//  supabase.js  —  client + data access layer
//  Every read here is BOUNDED (filtered + .limit()) so screens
//  stay fast no matter how big the tables get. Inserts/updates
//  are constant-cost and never slow down.
// ============================================================
import { createClient } from '@supabase/supabase-js';

// ---- CONFIG -------------------------------------------------
// Your project URL is already filled in. Paste your ANON public key
// (Supabase → Project Settings → API → "anon public").
// The anon key is safe to ship in frontend code — it is NOT the secret.
const SUPABASE_URL  = 'https://azfmpleswqixaslvcito.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6Zm1wbGVzd3FpeGFzbHZjaXRvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNDEwODMsImV4cCI6MjA5MzYxNzA4M30.JiK3xuihhqGoiiv8oUf14e-Mcggrd7gy368QgR0YYsA';
// -------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- MASTER LISTS (small, bounded, used to populate pickers) ----
export async function getSites() {
  const { data, error } = await supabase
    .from('sites')
    .select('id, name')
    .eq('active', true)
    .order('name')
    .limit(200);
  if (error) throw error;
  return data;
}

export async function getEmployees() {
  const { data, error } = await supabase
    .from('employees')
    .select('id, emp_code, full_name, position')
    .eq('active', true)
    .order('full_name')
    .limit(1000);            // bounded — paginate later if you ever exceed this
  if (error) throw error;
  return data;
}

export async function getItems() {
  const { data, error } = await supabase
    .from('items')
    .select('id, item_code, name, unit, track_type')
    .eq('active', true)
    .order('name')
    .limit(2000);            // bounded
  if (error) throw error;
  return data;
}

// ---- ACTIVE BORROWS (the one query that would slow down if unbounded) ----
// Only ever pulls items still 'out', for one site, capped. Stays fast forever.
export async function getOpenBorrows(siteId) {
  let q = supabase
    .from('borrow_issuance')
    .select('id, quantity, borrowed_at, due_at, project_vessel, issued_by, ' +
            'items(item_code, name, unit), employees(full_name, emp_code)')
    .eq('txn_type', 'borrow')
    .eq('status', 'out')
    .order('borrowed_at', { ascending: false })
    .limit(100);             // never "all" — a fixed window
  if (siteId) q = q.eq('site_id', siteId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// ---- WRITES -------------------------------------------------
// Insert: borrowed_at defaults to server now(). Never send a client timestamp.
export async function createTransaction(payload) {
  const { data, error } = await supabase
    .from('borrow_issuance')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Return via RPC so the timestamp is the SERVER clock, not the kiosk's.
export async function returnItem(txnId, condition) {
  const { error } = await supabase.rpc('mark_returned', {
    txn_id: txnId,
    cond: condition || null,
  });
  if (error) throw error;
}
