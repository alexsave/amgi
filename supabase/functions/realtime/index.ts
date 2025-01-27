/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            throw new Error('No authorization header');
        }

        const token = authHeader.replace('Bearer ', '');
        const { data: { user }, error: userError } = await supabase.auth.getUser(token);
        
        if (userError || !user) {
            throw new Error('Invalid token');
        }

        // Get user's subscription
        const { data: subscription, error: subError } = await supabase
            .from('user_subscriptions')
            .select('*, subscription_tiers(*)')
            .eq('user_id', user.id)
            .single();

        if (subError) {
            throw subError;
        }

        // Get current usage
        const now = new Date();
        const { data: usage, error: usageError } = await supabase
            .from('usage_tracking')
            .select('*')
            .eq('user_id', user.id)
            .lte('period_start', now.toISOString())
            .gte('period_end', now.toISOString())
            .single();

        if (usageError) {
            throw usageError;
        }

        // Check if user has exceeded their limit
        if (subscription.subscription_tiers.realtime_minutes_limit !== -1 && 
            usage.realtime_sessions_started >= subscription.subscription_tiers.realtime_minutes_limit) {
            throw new Error('You have reached your session limit for this billing period');
        }

        // Increment session count
        const { error: updateError } = await supabase
            .from('usage_tracking')
            .update({
                realtime_sessions_started: usage.realtime_sessions_started + 1
            })
            .eq('id', usage.id);

        if (updateError) {
            throw updateError;
        }

        // Generate OpenAI token
        const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${Deno.env.get("OPEN_AI_KEY")}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-realtime-preview-2024-12-17",
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
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        )
    }
}) 