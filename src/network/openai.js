const OPENAI_API_BASE = "https://api.openai.com/v1";
const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";

export const setupRealtimeStream = async (offer, token) => {
    console.log('Setting up realtime stream with OpenAI...');
    console.log('Using model:', REALTIME_MODEL);
    const response = await fetch(`${OPENAI_API_BASE}/realtime?model=${REALTIME_MODEL}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/sdp"
        },
    });

    if (!response.ok) {
        const error = `Failed to get remote description: ${response.statusText}`;
        console.error(error);
        throw new Error(error);
    }

    const sdp = await response.text();
    console.log('Got remote description from OpenAI');
    return {
        type: "answer",
        sdp
    };
}; 