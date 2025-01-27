import OpenAI from 'openai';
import { ApiInterface } from './ApiInterface';
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";

const FlashcardSchema = z.object({
  frontText: z.string(),
  backText: z.string(),
  sourceLang: z.string(),
  targetLang: z.string()
});

export class DirectApi extends ApiInterface {
  constructor() {
    super();
    this.client = null;
  }

  initialize(apiKey) {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true
    });
  }

  clear() {
    this.client = null;
  }

  async generateCard(userInput, targetLang, onProgress) {
    if (!this.client) throw new Error('OpenAI client not initialized');
    console.log('DirectApi.generateCard called:', { userInput, targetLang });

    try {
      console.log('Requesting OpenAI completion...');
      const completion = await this.client.beta.chat.completions.parse({
        model: "gpt-4o",
        messages: [
          { 
            role: "system", 
            content: "You are a helpful language learning assistant that creates flashcard pairs with accurate translations. First detect the source language of the input text. If the detected source language matches the requested target language, translate to English. Otherwise, translate to the requested target language." 
          },
          { 
            role: "user", 
            content: `Create a language learning flashcard pair for the following input. 
First detect the language. If the detected language matches ${targetLang}, translate to English (en). Otherwise, translate to ${targetLang}.
Input: ${userInput}

Return just the translation pair with language codes.`
          }
        ],
        response_format: zodResponseFormat(FlashcardSchema, "flashcard_generation"),
      });
      console.log('Received completion response:', completion);

      const card = completion.choices[0].message.parsed;
      console.log('Parsed card data:', card);
      onProgress({
        type: 'card',
        data: card
      });

      // Generate front audio
      console.log('Generating front audio...');
      const frontMp3 = await this.client.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: card.frontText,
      });
      const frontBuffer = await frontMp3.arrayBuffer();
      console.log('Front audio generated');
      onProgress({
        type: 'audio',
        side: 'front',
        url: URL.createObjectURL(new Blob([frontBuffer], { type: 'audio/mpeg' }))
      });

      // Generate back audio
      console.log('Generating back audio...');
      const backMp3 = await this.client.audio.speech.create({
        model: "tts-1",
        voice: "alloy",
        input: card.backText,
      });
      const backBuffer = await backMp3.arrayBuffer();
      console.log('Back audio generated');
      onProgress({
        type: 'audio',
        side: 'back',
        url: URL.createObjectURL(new Blob([backBuffer], { type: 'audio/mpeg' }))
      });

      console.log('Card generation complete');
      return {
        card,
        audioReady: { front: true, back: true }
      };
    } catch (error) {
      console.error('Error in DirectApi.generateCard:', error);
      throw new Error('Failed to generate card: ' + error.message);
    }
  }

  async evaluateSpeech({ audioBase64, expectedText, sourceLang, expectedAudioBase64 }) {
    if (!this.client) throw new Error('OpenAI client not initialized');

    try {
      const response = await this.client.chat.completions.create({
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
        tools: [{
          type: "function",
          function: {
            name: "evaluate_pronunciation",
            description: "Evaluate the pronunciation of a spoken phrase against an expected text.",
            parameters: {
              type: "object",
              properties: {
                result: {
                  type: "string",
                  enum: ["correct", "incorrect", "quit"],
                  description: "The evaluation result"
                },
                message: {
                  type: "string",
                  description: "Feedback message explaining the evaluation"
                }
              },
              required: ["result", "message"]
            }
          }
        }],
        tool_choice: { type: "function", function: { name: "evaluate_pronunciation" } }
      });

      const toolCall = response.choices[0].message.tool_calls?.[0];
      if (!toolCall) {
        throw new Error('No tool call in response');
      }

      const evaluation = JSON.parse(toolCall.function.arguments);
      return {
        result: evaluation.result,
        message: evaluation.message
      };
    } catch (error) {
      throw new Error('Failed to evaluate speech: ' + error.message);
    }
  }

  async getRealtimeToken() {
    if (!this.client) throw new Error('OpenAI client not initialized');

    try {
      const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.client.apiKey}`,
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
      return data.client_secret.value;
    } catch (error) {
      throw new Error('Failed to get realtime token: ' + error.message);
    }
  }
} 