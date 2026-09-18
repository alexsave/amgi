const OPENAI_API_BASE = "https://api.openai.com/v1";

/**
 * Exchanges a WebRTC SDP offer for an answer with the OpenAI Realtime API
 * (GA `/v1/realtime/calls` endpoint). `token` is the short-lived client
 * secret minted by the `realtime` edge function - the real API key never
 * reaches the browser.
 */
export const setupRealtimeStream = async (offer, token) => {
    const response = await fetch(`${OPENAI_API_BASE}/realtime/calls`, {
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
    return {
        type: "answer",
        sdp
    };
};
