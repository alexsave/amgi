import OpenAI from "openai";
import { z } from "zod";
import { zodResponseFormat } from "openai/helpers/zod";
import "jsr:@std/dotenv/load";

const openai = new OpenAI({
    apiKey: Deno.env.get("OPEN_AI_KEY"),
});

const FlashcardSchema = z.object({
    frontText: z.string(),
    backText: z.string(),
    sourceLang: z.string(),
    targetLang: z.string()
});

const encoder = new TextEncoder();

export async function generateCards(userInput, targetLang) {
    console.log('Starting generateCards with input:', { userInput, targetLang });
    try {
        console.log('Requesting translation from OpenAI...');
        const completion = await openai.beta.chat.completions.parse({
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

        const card = completion.choices[0].message.parsed;
        console.log('Received translation:', card);

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Send card data first
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'card',
                        data: card
                    }) + '\n'));

                    // Generate and send front audio
                    console.log('Generating front audio...');
                    const frontMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.frontText,
                    });
                    const frontBuffer = await frontMp3.arrayBuffer();
                    console.log('Front audio generated');
                    
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'audio',
                        side: 'front',
                        data: Array.from(new Uint8Array(frontBuffer))
                    }) + '\n'));
                    console.log('Front audio sent');

                    // Generate and send back audio
                    console.log('Generating back audio...');
                    const backMp3 = await openai.audio.speech.create({
                        model: "tts-1",
                        voice: "alloy",
                        input: card.backText,
                    });
                    const backBuffer = await backMp3.arrayBuffer();
                    console.log('Back audio generated');
                    
                    controller.enqueue(encoder.encode(JSON.stringify({
                        type: 'audio',
                        side: 'back',
                        data: Array.from(new Uint8Array(backBuffer))
                    }) + '\n'));
                    console.log('Back audio sent');

                    controller.close();
                    console.log('Stream closed');
                } catch (error) {
                    console.error('Error in stream:', error);
                    controller.error(error);
                }
            }
        });

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        console.error('Error in generateCards:', error);
        throw new Error('Failed to generate flashcard content');
    }
}
