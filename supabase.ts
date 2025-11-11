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

if (!process.env.SUPABASE_ANON_KEY) {
  throw new Error('Missing environment variable: SUPABASE_ANON_KEY');
}

// Create Supabase client with service role key for backend operations
// Service role bypasses RLS by default - use for all data operations
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false, // Don't auto refresh for service role
      persistSession: false    // Don't persist service role session
    }
  }
);

// Separate client for JWT verification and user authentication
// This client uses the anon key to properly handle user sessions
export const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY, // Use anon key for auth
  {
    auth: {
      autoRefreshToken: true,    // Enable auto refresh for user sessions
      persistSession: true,      // Enable session persistence
      detectSessionInUrl: true   // Detect auth tokens in URL
    }
  }
);
