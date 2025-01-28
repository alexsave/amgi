/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2.39.0"
import OpenAI from "npm:openai@4.28.0"


export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const evaluationTools = [{
  "type": "function",
  "function": {
    "name": "evaluate_pronunciation",
    "description": "Evaluate the pronunciation of a spoken phrase against an expected text.",
    "parameters": {
      "type": "object",
      "properties": {
        "result": {
          "type": "string",
          "enum": ["correct", "incorrect", "quit"],
          "description": "The evaluation result"
        },
        "message": {
          "type": "string",
          "description": "Feedback message explaining the evaluation"
        }
      },
      "required": ["result", "message"]
    }
  }
}];

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    console.log('Authenticating user with token...');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    console.log('Auth result:', { userId: user?.id, error: userError?.message });

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

      console.log('Subscription query result:', {
        subscription: sub ? {
          id: sub.id,
          tier: sub.subscription_tiers?.name,
          limit: sub.subscription_tiers?.voice_evaluations_limit
        } : null,
        error: subError?.message,
        details: subError?.details
      });

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

    console.log('Usage tracking query result:', {
      usage: usage ? {
        id: usage.id,
        evaluationsUsed: usage.voice_evaluations_used,
        periodStart: usage.period_start,
        periodEnd: usage.period_end
      } : null,
      error: usageError?.message,
      details: usageError?.details
    });

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
        console.error('Failed to create usage tracking:', createError);
        throw createError;
      }

      usage = newUsage;
      console.log('Created new usage tracking record:', {
        id: usage.id,
        periodStart: usage.period_start,
        periodEnd: usage.period_end
      });
    } else if (usageError) {
      throw usageError;
    }

    // Only check limits if billing is enabled
    if (enableBilling && subscription) {
      const limit = subscription.subscription_tiers.voice_evaluations_limit;
      const used = usage.voice_evaluations_used;
      console.log('Usage check:', { limit, used });

      if (limit !== -1 && used >= limit) {
        throw new Error('Voice evaluation limit exceeded for your subscription tier');
      }
    }

    const { audioBase64, expectedText, sourceLang, expectedAudioBase64 } = await req.json();
    console.log('Processing evaluation request:', { 
      sourceLang,
      expectedTextLength: expectedText?.length,
      hasAudio: !!audioBase64,
      hasExpectedAudio: !!expectedAudioBase64
    });

    const openai = new OpenAI({
      apiKey: Deno.env.get("OPENAI_KEY"),
    });

    const response = await openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      messages: [
        {
          role: "system",
          content: `You are a language learning assistant evaluating pronunciation. First, check if the audio contains commands like "skip", "quit", "next", or "give up". If it does, call evaluate_pronunciation with result "quit" and message "User requested to skip".

If no command is detected, compare the pronunciation with the expected text "${expectedText}" in ${sourceLang}. If the pronunciation is good, call evaluate_pronunciation with result "correct" and a brief praise message. If the pronunciation needs improvement, call evaluate_pronunciation with result "incorrect" and a brief explanation of what was wrong.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Here is the correct pronunciation:" },
            { type: "audio", audio: { data: expectedAudioBase64, format: "mp3" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Evaluate this pronunciation:" },
            { type: "audio", audio: { data: audioBase64, format: "mp3" } }
          ]
        }
      ],
      tools: evaluationTools,
      tool_choice: { type: "function", function: { name: "evaluate_pronunciation" } }
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall) {
      throw new Error('No tool call in response');
    }

    const evaluation = JSON.parse(toolCall.function.arguments);

    // Always update usage tracking, even if billing is disabled
    console.log('Updating usage count from', usage.voice_evaluations_used, 'to', usage.voice_evaluations_used + 1);
    const { error: updateError } = await supabase
      .from('usage_tracking')
      .update({
        voice_evaluations_used: usage.voice_evaluations_used + 1
      })
      .eq('id', usage.id);

    if (updateError) {
      console.error('Failed to update usage:', updateError);
      throw updateError;
    }

    console.log('Successfully processed evaluation');
    return new Response(
      JSON.stringify({
        result: evaluation.result,
        message: evaluation.message,
        audio: response.choices[0].message.audio?.data
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}); 