// supabase.js — shared Supabase client + helpers for RSR apps
// Imported by home.js, coordinator.js, etc. as: import { supabase, getSites } from './supabase.js'
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://wpmcbjrisuyjvobvzaus.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwbWNianJpc3V5anZvYnZ6YXVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4NjU3ODQsImV4cCI6MjA5MzQ0MTc4NH0.EGyUnXmVkUrsEteKICMRSOXURxYXPOaKUs8EYCpw6_0';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Returns the list of sites, ordered by name.
export async function getSites() {
  const { data, error } = await supabase.from('sites').select('*').order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}
