/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequest, HttpError } from "../_shared/handler.ts";
import { checkAndIncrementUsage } from "../_shared/billing.ts";
import { createOpenAIClient, SPEECH_EVALUATION_MODEL, TTS_MODEL } from "../_shared/openai.ts";
import { supabaseAdmin } from "../_shared/supabase.ts";
import { spokenForm } from "../_shared/cardText.ts";
import type OpenAI from "npm:openai@^6.5.0";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const evaluationTools = [{
  type: "function" as const,
  function: {
    name: "evaluate_pronunciation",
    description: "Evaluate the pronunciation of a spoken phrase against an expected text.",
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
        },
        transcription: {
          type: "string",
          description: "What the learner actually said, transcribed in the target language's script"
        }
      },
      required: ["result", "message", "transcription"],
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
): Promise<string> {
  if (expectedAudioPath) {
    const { data, error } = await supabaseAdmin.storage
      .from('card-audio')
      .download(expectedAudioPath);
    if (error) {
      throw new Error(`Failed to load expected audio from storage: ${error.message}`);
    }
    return encodeBase64(await data.arrayBuffer());
  }
  if (expectedAudioBase64) {
    return expectedAudioBase64;
  }
  throw new Error('Missing reference audio: provide expected_audio_path or expected_audio_base64');
}

/**
 * Turns the written feedback into spoken feedback. Audio-capable chat models
 * don't emit audio on tool-call turns, so this is a separate TTS step.
 * Failure here shouldn't sink an otherwise successful evaluation.
 */
async function speakFeedback(openai: OpenAI, message: string): Promise<string | null> {
  try {
    const speech = await openai.audio.speech.create({
      model: TTS_MODEL,
      voice: "alloy",
      input: message,
      instructions: "You are a friendly language tutor giving brief spoken feedback. Sound encouraging and natural.",
    });
    return encodeBase64(await speech.arrayBuffer());
  } catch (error) {
    console.warn('Feedback TTS failed:', error.message);
    return null;
  }
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

  // Load the reference audio BEFORE touching the user's quota - a stale
  // storage path must not burn an evaluation credit.
  const expectedAudio = await loadExpectedAudio(expected_audio_path, expected_audio_base64);

  const { allowed } = await checkAndIncrementUsage(user.id, 'voice_evaluations_used');
  if (!allowed) {
    throw new HttpError('You have reached your voice evaluation limit for this billing period', 403);
  }

  const openai = createOpenAIClient();

  // The learner is graded on what they were asked to SAY. A card's known side
  // can carry labels the learner reads but nobody speaks - which sense the
  // card teaches, which politeness level - and cards generated before those
  // labels had a convention can carry a whole second sense in parentheses.
  // Grading against that string marks a perfect utterance wrong for omitting
  // a gloss, so the evaluator only ever sees the spoken form.
  const expectedSpoken = spokenForm(expected_text!);

  const response = await openai.chat.completions.create({
    model: SPEECH_EVALUATION_MODEL,
    messages: [
      {
        role: "system",
        content: `You are a language learning assistant evaluating pronunciation. The learner knows ${front_lang || 'English'} and is learning ${back_lang}.

Compare the learner's pronunciation with the expected text "${expectedSpoken}" in ${back_lang}. Judge whether the words are right and intelligibly pronounced - be encouraging about accent, strict about wrong or missing words. Call evaluate_pronunciation with: a transcription of what the learner actually said; result "correct" with a brief praise message if the pronunciation is good, or result "incorrect" with one concrete, brief tip about what to fix.`
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Here is the correct pronunciation:" },
          { type: "input_audio", input_audio: { data: expectedAudio, format: "mp3" } }
        ]
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Evaluate this pronunciation:" },
          { type: "input_audio", input_audio: { data: audio_base64!, format: "mp3" } }
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

  return {
    result: evaluation.result,
    message: evaluation.message,
    transcription: evaluation.transcription ?? null,
    audio: await speakFeedback(openai, evaluation.message),
  };
}));
