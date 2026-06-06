// ============================================================
//  supabase.js  —  client + shared data access
//  Points at the UNIFIED (kiosk) database so tools, attendance,
//  leave and people all share one employee list.
//  Reads are bounded (filtered + .limit()) to stay fast.
// ============================================================
import { createClient } from '@supabase/supabase-js';

// ---- CONFIG (unified kiosk project) ------------------------
const SUPABASE_URL  = 'https://wpmcbjrisuyjvobvzaus.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwbWNianJpc3V5anZvYnZ6YXVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NjU3ODQsImV4cCI6MjA5MzQ0MTc4NH0.EGyUnXmVkUrsEteKICMRSOXURxYXPOaKUs8EYCpw6_0';
// -------------------------------------------------------------

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- MASTER LISTS (small, bounded, used to populate pickers) ----
export async function getSites() {
  const { data, error } = await supabase
    .from('sites')
    .select('id, name')
    .order('name')
    .limit(200);
  if (error) throw error;
  return data;
}

export async function getEmployees() {
  const { data, error } = await supabase
    .from('employees')
    .select('id, name, code, position')
    .order('name')
    .limit(2000);
  if (error) throw error;
  return data;
}

export async function getItems() {
  const { data, error } = await supabase
    .from('items')
    .select('id, item_code, name, unit, track_type')
    .eq('active', true)
    .order('name')
    .limit(2000);
  if (error) throw error;
  return data;
}

// ---- WRITES -------------------------------------------------
export async function createTransaction(payload) {
  const { data, error } = await supabase
    .from('borrow_issuance')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function returnItem(txnId, condition) {
  const { error } = await supabase.rpc('mark_returned', {
    txn_id: txnId, cond: condition || null,
  });
  if (error) throw error;
}
