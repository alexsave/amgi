import type { User } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, handleCors } from "./cors.ts";
import { getAuthenticatedUser } from "./auth.ts";

/**
 * Error subclass that carries an HTTP status code. Throw it anywhere inside a
 * wrapped handler to control the response status (e.g. 403 for quota limits).
 */
export class HttpError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

interface HandlerContext {
    req: Request;
    user: User;
    body: Record<string, unknown>;
}

/**
 * Owns the request lifecycle for every edge function:
 * CORS preflight -> auth -> JSON body parse -> handler -> JSON response.
 * Handlers just return a plain object and throw on failure; any thrown error
 * becomes `{ error }` JSON with the HttpError status (400 by default).
 */
export function wrapRequest(
    handler: (ctx: HandlerContext) => Promise<Record<string, unknown>>,
) {
    return async (req: Request): Promise<Response> => {
        const corsResponse = handleCors(req);
        if (corsResponse) return corsResponse;

        const reqId = crypto.randomUUID().split('-')[0];
        const startedAt = Date.now();

        try {
            const user = await getAuthenticatedUser(req);

            let body: Record<string, unknown> = {};
            try {
                body = await req.json();
            } catch (_e) {
                // No body / invalid JSON — treat as empty.
            }

            const result = await handler({ req, user, body });

            console.log(`[${reqId}] ok user=${user.id} ${Date.now() - startedAt}ms`);
            return new Response(JSON.stringify(result), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        } catch (error) {
            const status = error instanceof HttpError ? error.status : 400;
            console.error(`[${reqId}] error status=${status} ${Date.now() - startedAt}ms:`, error.message);
            return new Response(JSON.stringify({ error: error.message }), {
                status,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    };
}
