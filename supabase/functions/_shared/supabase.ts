import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Single service-role client shared by all edge functions.
 * All privileged database and storage access goes through this client;
 * user identity is verified separately in auth.ts.
 */
export const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);
