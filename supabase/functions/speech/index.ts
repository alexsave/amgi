/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import OpenAI from "npm:openai@4.24.0"

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

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
        return new Response('ok', { headers: corsHeaders })
    }

    try {
        const openai = new OpenAI({
            apiKey: Deno.env.get('OPENAI_KEY'),
        });

        const { audioBase64, expectedText, sourceLang, expectedAudioBase64 } = await req.json()

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
        const evaluationResult = {
            result: evaluation.result,
            message: evaluation.message,
            audio: response.choices[0].message.audio?.data
        };

        return new Response(
            JSON.stringify(evaluationResult),
            {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        );

    } catch (error) {
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
        )
    }
}) 