import { REALTIME_MODEL } from "../constants/constants";

const OPENAI_API_BASE = "https://api.openai.com/v1";

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