/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from '@supabase/supabase-js'
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: Deno.env.get("OPEN_AI_KEY"),
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

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
    if (subscription.subscription_tiers.voice_evaluations_limit !== -1 && 
        usage.voice_evaluations_used >= subscription.subscription_tiers.voice_evaluations_limit) {
      throw new Error('Voice evaluation limit exceeded for your subscription tier');
    }

    const { audioBase64, expectedText, sourceLang, expectedAudioBase64 } = await req.json();

    const response = await openai.chat.completions.create({
      model: "gpt-4-vision-preview",
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

    // Update usage tracking
    const { error: updateError } = await supabase
      .from('usage_tracking')
      .update({
        voice_evaluations_used: usage.voice_evaluations_used + 1
      })
      .eq('id', usage.id);

    if (updateError) {
      throw updateError;
    }

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