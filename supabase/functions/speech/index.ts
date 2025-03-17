/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "npm:@supabase/supabase-js@2.39.0"
import OpenAI from "npm:openai@4.28.0"
import { checkAndIncrementUsage } from "../_shared/billing.ts";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { createOpenAIClient } from "../_shared/openai.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

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

  // Handle CORS preflight requests
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    // Authenticate the user
    console.log('Authenticating user');
    const user = await getAuthenticatedUser(req);
    console.log('Authentication successful for user:', user.id);

    // Parse the request data first to validate it
    const { audio_base64, expected_text, back_lang, expected_audio_base64, front_lang } = await req.json();
    console.log('Request validation:', {
      hasAudioBase64: !!audio_base64,
      expectedTextPresent: !!expected_text,
      backLangPresent: !!back_lang,
      frontLangPresent: !!front_lang,
      hasExpectedAudio: !!expected_audio_base64
    });

    if (!audio_base64 || !expected_text || !back_lang) {
      const missingFields = [];
      if (!audio_base64) missingFields.push('audio_base64');
      if (!expected_text) missingFields.push('expected_text');
      if (!back_lang) missingFields.push('back_lang');
      throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
    }

    // Check if the user can use voice evaluations and increment usage
    const { allowed, usage, subscription } = await checkAndIncrementUsage(
      user.id,
      'voice_evaluations_used'
    );

    if (!allowed) {
      console.error('User has reached their voice evaluation limit');
      return new Response(
        JSON.stringify({
          error: 'You have reached your voice evaluation limit for this billing period'
        }),
        {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        }
      );
    }

    console.log('Usage check passed, proceeding with voice evaluation');

    // Get OpenAI client
    console.log('Initializing OpenAI client');
    const openai = createOpenAIClient();

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

    // At the end of processing, return the result
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