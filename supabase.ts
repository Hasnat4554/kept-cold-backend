import dotenv from "dotenv";
dotenv.config(); // load env variables immediately, before using them


import { createClient } from '@supabase/supabase-js';

console.log('Supabase URL:', process.env.SUPABASE_URL);
if (!process.env.SUPABASE_URL) {
  throw new Error('Missing environment variable: SUPABASE_URL');
}

if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing environment variable: SUPABASE_SERVICE_ROLE_KEY');
}

// Create Supabase client with service role key for backend operations
// Service role bypasses RLS by default - use for all data queries
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// Separate client for JWT verification only (doesn't affect service-role client's auth)
// This prevents auth.getUser() from changing the main client's RLS context
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);
