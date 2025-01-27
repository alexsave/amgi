import OpenAI from 'openai';

let openaiClient = null;

export const initializeOpenAI = (apiKey) => {
  openaiClient = new OpenAI({
    apiKey,
    dangerouslyAllowBrowser: true // Required for browser usage
  });
  localStorage.setItem('OPENAI_KEY', apiKey);
};

export const clearOpenAI = () => {
  openaiClient = null;
  localStorage.removeItem('OPENAI_KEY');
};

export const getStoredApiKey = () => {
  return localStorage.getItem('OPENAI_KEY');
};

// Speech evaluation function (from speech/index.ts)
export const evaluateSpeech = async ({ audioBase64, expectedText, sourceLang, expectedAudioBase64 }) => {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  try {
    const response = await openaiClient.chat.completions.create({
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
      message: evaluation.message,
      audio: response.choices[0].message.audio?.data
    };
  } catch (error) {
    throw new Error('Failed to evaluate speech: ' + error.message);
  }
};

// Card generation function (from cards/index.ts)
export const generateCard = async ({ userInput, targetLang }, onProgress) => {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  try {
    const completion = await openaiClient.chat.completions.create({
      model: "gpt-4",
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
      response_format: { type: "json_object" }
    });

    const card = JSON.parse(completion.choices[0].message.content);
    onProgress({ type: 'text', data: card });

    // Generate front audio
    const frontMp3 = await openaiClient.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: card.frontText,
    });
    const frontBuffer = await frontMp3.arrayBuffer();
    onProgress({
      type: 'audio',
      side: 'front',
      url: URL.createObjectURL(new Blob([frontBuffer], { type: 'audio/mpeg' }))
    });

    // Generate back audio
    const backMp3 = await openaiClient.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: card.backText,
    });
    const backBuffer = await backMp3.arrayBuffer();
    onProgress({
      type: 'audio',
      side: 'back',
      url: URL.createObjectURL(new Blob([backBuffer], { type: 'audio/mpeg' }))
    });

    return {
      card,
      audioReady: { front: true, back: true }
    };
  } catch (error) {
    throw new Error('Failed to generate card: ' + error.message);
  }
};

// Realtime token function (from realtime/index.ts)
export const getRealtimeToken = async () => {
  if (!openaiClient) throw new Error('OpenAI client not initialized');

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiClient.apiKey}`,
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

    return await response.json();
  } catch (error) {
    throw new Error('Failed to get realtime token: ' + error.message);
  }
}; 