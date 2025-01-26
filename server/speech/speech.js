import OpenAI from "openai";

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

export async function evaluateSpeech(audioBase64, expectedText, sourceLang, expectedAudioBase64) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "mp3" },
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
                        { type: "input_audio", input_audio: { data: expectedAudioBase64, format: "mp3" } }
                    ]
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Evaluate this pronunciation:" },
                        { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" } }
                    ]
                }
            ],
            tools: evaluationTools,
            tool_choice: { type: "function", function: { name: "evaluate_pronunciation" } }
        });

        console.log('GPT-4 Audio raw response:', response);
        console.log('GPT-4 Audio response message:', response.choices[0].message);
        console.log('GPT-4 Audio data present:', !!response.choices[0].message.audio);
        if (response.choices[0].message.audio) {
            console.log('GPT-4 Audio data type:', typeof response.choices[0].message.audio);
            console.log('GPT-4 Audio data keys:', Object.keys(response.choices[0].message.audio));
            console.log('GPT-4 Audio data length:', response.choices[0].message.audio?.data?.length);
        }

        const toolCall = response.choices[0].message.tool_calls?.[0];
        if (!toolCall) {
            throw new Error('No tool call in response');
        }

        const evaluation = JSON.parse(toolCall.function.arguments);
        console.log('Parsed evaluation:', evaluation);

        const evaluationResult = {
            result: evaluation.result,
            message: evaluation.message,
            audio: response.choices[0].message.audio?.data
        };

        console.log('Sending evaluation result with audio:', !!evaluationResult.audio);
        if (evaluationResult.audio) {
            console.log('Audio data length in result:', evaluationResult.audio.length);
        }

        return new Response(JSON.stringify(evaluationResult), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (error) {
        console.error('Error evaluating speech:', error);
        throw new Error('Failed to evaluate speech: ' + error.message);
    }
}
