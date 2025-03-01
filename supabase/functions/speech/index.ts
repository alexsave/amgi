/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2.39.0"
import OpenAI from "npm:openai@4.28.0"
import { getOrCreateUsage } from "../_shared/billing.ts";


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
  console.log('Received request:', {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries())
  });

  if (req.method === 'OPTIONS') {
    console.log('Handling CORS preflight request');
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    console.log('Authorization header present:', !!authHeader);
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    console.log('Token extracted, first 10 chars:', token.substring(0, 10) + '...');

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

    // Get or create usage tracking record
    const usage = await getOrCreateUsage(user.id, subscription);
    console.log('Usage tracking record:', {
      id: usage.id,
      evaluationsUsed: usage.voice_evaluations_used,
      periodStart: usage.period_start,
      periodEnd: usage.period_end
    });

    // Only check limits if billing is enabled
    if (enableBilling && subscription) {
      const limit = subscription.subscription_tiers.voice_evaluations_limit;
      const used = usage.voice_evaluations_used;
      console.log('Usage check:', { limit, used });

      if (limit !== -1 && used >= limit) {
        throw new Error('Voice evaluation limit exceeded for your subscription tier');
      }
    }

    const { audio_base64, expected_text, back_lang, expected_audio_base64, front_lang } = await req.json();
    console.log('Request validation:', {
      hasAudioBase64: !!audio_base64,
      audioBase64Length: audio_base64?.length,
      audioBase64Prefix: audio_base64?.substring(0, 50),
      expectedTextPresent: !!expected_text,
      backLangPresent: !!back_lang,
      backLang: back_lang,
      frontLangPresent: !!front_lang,
      frontLang: front_lang,
      hasExpectedAudio: !!expected_audio_base64,
      expectedAudioLength: expected_audio_base64?.length,
      expectedAudioPrefix: expected_audio_base64?.substring(0, 50)
    });

    if (!audio_base64 || !expected_text || !back_lang) {
      const missingFields = [];
      if (!audio_base64) missingFields.push('audio_base64');
      if (!expected_text) missingFields.push('expected_text');
      if (!back_lang) missingFields.push('back_lang');
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Validate base64 format
    const isValidBase64 = (str) => {
      try {
        return btoa(atob(str)) === str;
      } catch (err) {
        return false;
      }
    };

    console.log('Base64 validation:', {
      isValidUserAudio: isValidBase64(audio_base64),
      isValidExpectedAudio: isValidBase64(expected_audio_base64)
    });

    console.log('Initializing OpenAI client');
    const openai = new OpenAI({
      apiKey: Deno.env.get("OPENAI_KEY"),
    });

    console.log('Starting OpenAI chat completion request with params:', {
      model: "gpt-4o-audio-preview",
      expectedText: expected_text,
      backLang: back_lang
    });
    const response = await openai.chat.completions.create({
      model: "gpt-4o-audio-preview",
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "mp3" },
      messages: [
        {
          role: "system",
          content: `You are a language learning assistant evaluating pronunciation. First, check if the audio contains commands like "skip", "quit", "next", or "give up". If it does, call evaluate_pronunciation with result "quit" and message "User requested to skip".

If no command is detected, compare the pronunciation with the expected text "${expected_text}" in ${back_lang}. If the pronunciation is good, call evaluate_pronunciation with result "correct" and a brief praise message. If the pronunciation needs improvement, call evaluate_pronunciation with result "incorrect" and a brief explanation of what was wrong.`
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Here is the correct pronunciation:" },
            { type: "input_audio", input_audio: { data: expected_audio_base64, format: "mp3" } }
          ]
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Evaluate this pronunciation:" },
            { type: "input_audio", input_audio: { data: audio_base64, format: "mp3" } }
          ]
        }
      ],
      tools: evaluationTools,
      tool_choice: { type: "function", function: { name: "evaluate_pronunciation" } }
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    console.log('OpenAI response received:', {
      hasToolCall: !!toolCall,
      toolCallName: toolCall?.function?.name,
      responseChoices: response.choices.length
    });

    if (!toolCall) {
      throw new Error('No tool call in response');
    }

    const evaluation = JSON.parse(toolCall.function.arguments);
    console.log('Evaluation result:', {
      result: evaluation.result,
      messageLength: evaluation.message?.length
    });

    // Always update usage tracking, even if billing is disabled
    console.log('Updating usage tracking:', {
      usageId: usage.id,
      currentCount: usage.voice_evaluations_used,
      newCount: usage.voice_evaluations_used + 1
    });
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
    console.error('Error processing request:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause
    });
    
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}); 