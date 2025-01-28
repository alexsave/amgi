import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? ''
);

export async function getAuthenticatedUser(req: Request) {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        throw new Error('No authorization header');
    }

    const { data: { user }, error } = await supabase.auth.getUser(authHeader);
    if (error || !user) {
        throw new Error('Invalid token');
    }

    return user;
} 