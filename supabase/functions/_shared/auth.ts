import type { User } from "jsr:@supabase/supabase-js@2";
import { supabaseAdmin } from "./supabase.ts";

/**
 * Authenticates a user from the request's Authorization header.
 *
 * Fast path: verify the JWT locally against the project's JWKS via
 * `auth.getClaims()` (no GoTrue round-trip). Falls back to `auth.getUser()`
 * for projects still using symmetric (HS256) JWT signing keys.
 *
 * @param req The incoming request object
 * @returns The authenticated user (or a minimal user built from JWT claims)
 * @throws Error if the authorization header is missing or the token is invalid
 */
export async function getAuthenticatedUser(req: Request): Promise<User> {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');

    // Fast path: local verification against JWKS (asymmetric keys only).
    try {
        const { data, error } = await supabaseAdmin.auth.getClaims(token);
        if (!error && data?.claims?.sub) {
            return claimsToUser(data.claims);
        }
    } catch (_e) {
        // getClaims unavailable or key type unsupported — fall through to getUser.
    }

    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error) {
        throw new Error(`Invalid token: ${error.message}`);
    }

    if (!user) {
        throw new Error('User not found');
    }

    return user;
}

function claimsToUser(claims: Record<string, unknown>): User {
    return {
        id: claims.sub,
        email: claims.email,
        user_metadata: claims.user_metadata ?? {},
        app_metadata: claims.app_metadata ?? {},
        aud: claims.aud ?? 'authenticated',
        created_at: '',
    } as User;
}
