/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequest, HttpError } from "../_shared/handler.ts";
import { checkAndIncrementUsage } from "../_shared/billing.ts";
import { REALTIME_MODEL } from "../_shared/openai.ts";

/**
 * Mints a short-lived Realtime client secret (GA API) so the browser can open
 * a WebRTC session directly with OpenAI without ever seeing our API key.
 * Session behavior (instructions, tools) is configured client-side over the
 * data channel once connected.
 */
Deno.serve(wrapRequest(async ({ user }) => {
    const { allowed } = await checkAndIncrementUsage(user.id, 'realtime_sessions_started');
    if (!allowed) {
        throw new HttpError('You have reached your realtime session limit for this billing period', 403);
    }

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${Deno.env.get("OPENAI_KEY")}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            expires_after: { anchor: "created_at", seconds: 600 },
            session: {
                type: "realtime",
                model: REALTIME_MODEL,
                audio: {
                    output: { voice: "marin" },
                },
            },
        }),
    });

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Failed to generate realtime client secret: ${response.status} ${detail}`);
    }

    const data = await response.json();

    return {
        client_secret: data.value,
        expires_at: data.expires_at,
        model: REALTIME_MODEL,
    };
}));
