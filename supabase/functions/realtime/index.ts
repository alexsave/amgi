/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2.39.0"
import { checkAndIncrementUsage } from "../_shared/billing.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

serve(async (req) => {
    // Handle CORS
    const corsResponse = handleCors(req);
    if (corsResponse) return corsResponse;

    try {
        // Authenticate the user
        const user = await getAuthenticatedUser(req);
        console.log('User authenticated:', user.id);

        // Check if the user can start a realtime session and increment usage
        const { allowed, usage, subscription } = await checkAndIncrementUsage(
            user.id,
            'realtime_sessions_started'
        );

        if (!allowed) {
            console.error('User has reached their realtime session limit');
            return new Response(
                JSON.stringify({
                    error: 'You have reached your realtime session limit for this billing period'
                }),
                {
                    status: 403,
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                }
            );
        }

        console.log('Usage updated, proceeding with realtime session');

        // Generate OpenAI token
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${Deno.env.get("OPENAI_KEY")}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                // This doesn't actually seem to be enforced anywhere when you start a sess
                model: "gpt-4o-mini-realtime-preview",
                voice: "shimmer",
            }),
        });

        if (!response.ok) {
            throw new Error(`Failed to generate token: ${response.statusText}`);
        }

        const data = await response.json();
        
        return new Response(
            JSON.stringify(data),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );

    } catch (error) {
        console.error('Error processing request:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        )
    }
}) 