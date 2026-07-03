/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequest, HttpError } from "../_shared/handler.ts";
import { checkAndIncrementUsage } from "../_shared/billing.ts";
import { createOpenAIClient, SPEECH_EVALUATION_MODEL } from "../_shared/openai.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const evaluationTools = [{
  type: "function" as const,
  function: {
    name: "evaluate_pronunciation",
    description: "Evaluate the pronunciation of a spoken phrase against an expected text.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        result: {
          type: "string",
          enum: ["correct", "incorrect"],
          description: "The evaluation result"
        },
        message: {
          type: "string",
          description: "Feedback message explaining the evaluation"
        }
      },
      required: ["result", "message"],
      additionalProperties: false
    }
  }
}];

/**
 * Loads the reference pronunciation as base64 mp3. Prefers a storage path
 * (small request payload, one download inside the data center) and falls
 * back to inline base64 for older clients.
 */
async function loadExpectedAudio(
  expectedAudioPath: string | undefined,
  expectedAudioBase64: string | undefined,
): Promise<string | null> {
  if (expectedAudioPath) {
    const { data, error } = await supabaseAdmin.storage
      .from('card-audio')
      .download(expectedAudioPath);
    if (error) {
      throw new Error(`Failed to load expected audio from storage: ${error.message}`);
    }
    return encodeBase64(await data.arrayBuffer());
  }
  return expectedAudioBase64 ?? null;
}

Deno.serve(wrapRequest(async ({ user, body }) => {
  const {
    audio_base64,
    expected_text,
    back_lang,
    front_lang,
    expected_audio_path,
    expected_audio_base64,
  } = body as Record<string, string | undefined>;

  const missingFields = [
    !audio_base64 && 'audio_base64',
    !expected_text && 'expected_text',
    !back_lang && 'back_lang',
  ].filter(Boolean);
  if (missingFields.length > 0) {
    throw new Error(`Missing required fields: ${missingFields.join(', ')}`);
  }

  const { allowed } = await checkAndIncrementUsage(user.id, 'voice_evaluations_used');
  if (!allowed) {
    throw new HttpError('You have reached your voice evaluation limit for this billing period', 403);
  }

  const expectedAudio = await loadExpectedAudio(expected_audio_path, expected_audio_base64);

  const openai = createOpenAIClient();

  const messages = [
    {
      role: "system" as const,
      content: `You are a language learning assistant evaluating pronunciation. The learner knows ${front_lang || 'English'} and is learning ${back_lang}.

Compare the learner's pronunciation with the expected text "${expected_text}" in ${back_lang}. Judge whether the words are right and intelligibly pronounced — be encouraging about accent, strict about wrong or missing words. If the pronunciation is good, call evaluate_pronunciation with result "correct" and a brief praise message. If it needs improvement, call evaluate_pronunciation with result "incorrect" and one concrete, brief tip about what to fix.`
    },
    ...(expectedAudio ? [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Here is the correct pronunciation:" },
        { type: "input_audio" as const, input_audio: { data: expectedAudio, format: "mp3" as const } }
      ]
    }] : []),
    {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Evaluate this pronunciation:" },
        { type: "input_audio" as const, input_audio: { data: audio_base64!, format: "mp3" as const } }
      ]
    }
  ];

  const response = await openai.chat.completions.create({
    model: SPEECH_EVALUATION_MODEL,
    modalities: ["text", "audio"],
    audio: { voice: "alloy", format: "mp3" },
    messages,
    tools: evaluationTools,
    tool_choice: { type: "function", function: { name: "evaluate_pronunciation" } }
  });

  const toolCall = response.choices[0].message.tool_calls?.[0];
  if (!toolCall) {
    throw new Error('No tool call in response');
  }

  const evaluation = JSON.parse(toolCall.function.arguments);

  return {
    result: evaluation.result,
    message: evaluation.message,
    audio: response.choices[0].message.audio?.data ?? null,
  };
}));
