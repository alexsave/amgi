import { createClient } from '@supabase/supabase-js';

const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

export async function getAuthenticatedUser(req: Request) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabaseClient.auth.getUser(token);
    if (error || !user) {
        throw new Error('Invalid token');
    }

    return user;
} 