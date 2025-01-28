/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2.39.0"

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

        const enableBilling = Deno.env.get('ENABLE_BILLING') === 'true';
        console.log('Billing enabled:', enableBilling);

        // Get user's subscription if billing is enabled
        let subscription = null;
        if (enableBilling) {
            console.log('Fetching subscription for user:', user.id);
            const { data: sub, error: subError } = await supabase
                .from('user_subscriptions')
                .select('*, subscription_tiers(*)')
                .eq('user_id', user.id)
                .single();

            if (subError) {
                throw subError;
            }
            subscription = sub;
        }

        // Always track usage, even if billing is disabled
        const now = new Date();
        console.log('Fetching usage tracking for period:', now.toISOString());
        
        let { data: usage, error: usageError } = await supabase
            .from('usage_tracking')
            .select('*')
            .eq('user_id', user.id)
            .lte('period_end', now.toISOString())
            .gte('period_start', now.toISOString())
            .single();

        // If no usage record exists, create one
        if (usageError?.message === 'JSON object requested, multiple (or no) rows returned') {
            console.log('No usage tracking found, creating new record');
            
            // Use subscription period if available, otherwise create a monthly period
            let periodStart, periodEnd;
            if (subscription) {
                periodStart = new Date(subscription.current_period_start);
                periodEnd = new Date(subscription.current_period_end);
            } else {
                periodStart = new Date(now.getFullYear(), now.getMonth(), 1); // Start of current month
                periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // End of current month
            }
            
            const { data: newUsage, error: createError } = await supabase
                .from('usage_tracking')
                .insert({
                    user_id: user.id,
                    voice_evaluations_used: 0,
                    realtime_sessions_started: 0,
                    period_start: periodStart.toISOString(),
                    period_end: periodEnd.toISOString()
                })
                .select()
                .single();

            if (createError) {
                throw createError;
            }

            usage = newUsage;
        } else if (usageError) {
            throw usageError;
        }

        // Only check limits if billing is enabled
        if (enableBilling && subscription) {
            if (subscription.subscription_tiers.realtime_minutes_limit !== -1 && 
                usage.realtime_sessions_started >= subscription.subscription_tiers.realtime_minutes_limit) {
                throw new Error('You have reached your session limit for this billing period');
            }
        }

        // Always track usage
        console.log('Updating usage count from', usage.realtime_sessions_started, 'to', usage.realtime_sessions_started + 1);
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