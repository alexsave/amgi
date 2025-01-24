import OpenAI from "openai";

export async function voiceChat(audioBase64, currentCard) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "mp3" },
            messages: [
                {
                    role: "system",
                    content: `You are a helpful language learning tutor. The user is practicing with flashcards. 
                    The current card's front text is "${currentCard.frontText}" and back text is "${currentCard.backText}".
                    Help the user practice pronunciation, answer questions about the word/phrase, or provide examples.
                    Keep responses brief and focused. If you hear "quit" or "exit", inform them they can toggle voice mode off.`
                },
                {
                    role: "user",
                    content: [
                        { type: "input_audio", input_audio: { data: audioBase64, format: "mp3" }}
                    ]
                }
            ]
        });

        const audioResponse = response.choices[0].message.audio?.data;
        const textResponse = response.choices[0].message.content;

        return new Response(JSON.stringify({
            text: textResponse,
            audio: audioResponse
        }), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        });
    } catch (error) {
        console.error('Error in voice chat:', error);
        throw new Error('Failed to process voice chat: ' + error.message);
    }
}
