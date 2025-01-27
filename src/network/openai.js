const OPENAI_API_BASE = "https://api.openai.com/v1";
const REALTIME_MODEL = "gpt-4o-realtime-preview-2024-12-17";

export const setupRealtimeStream = async (offer, token) => {
    const response = await fetch(`${OPENAI_API_BASE}/realtime?model=${REALTIME_MODEL}`, {
        method: "POST",
        body: offer.sdp,
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/sdp"
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to get remote description: ${response.statusText}`);
    }

    return {
        type: "answer",
        sdp: await response.text(),
    };
}; 