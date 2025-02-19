import { createClient } from '@supabase/supabase-js';

const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') || '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

export interface UsageData {
    id: string;
    user_id: string;
    realtime_sessions_started: number;
    voice_evaluations_used: number;
    card_audio_generations_used: number;
    period_start: string;
    period_end: string;
}

export interface SubscriptionData {
    id: string;
    user_id: string;
    current_period_start: string;
    current_period_end: string;
    subscription_tiers: {
        realtime_minutes_limit: number;
        voice_evaluations_limit: number;
        card_audio_generations_limit: number;
    };
}

const DEFAULT_SUBSCRIPTION_LIMITS = {
    realtime_minutes_limit: 0,
    voice_evaluations_limit: 0,
    card_audio_generations_limit: 0
};

const DEFAULT_USAGE = {
    realtime_sessions_started: 0,
    voice_evaluations_used: 0,
    card_audio_generations_used: 0
};

export async function getSubscription(userId: string): Promise<SubscriptionData | null> {
    const { data: subscriptions, error } = await supabaseClient
        .from('user_subscriptions')
        .select('*, subscription_tiers(*)')
        .eq('user_id', userId);

    if (error) {
        console.error('Error fetching subscription:', error);
        throw error;
    }

    if (!subscriptions || subscriptions.length === 0) {
        const now = new Date();
        return {
            id: 'free',
            user_id: userId,
            current_period_start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
            current_period_end: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
            subscription_tiers: DEFAULT_SUBSCRIPTION_LIMITS
        };
    }

    // Ensure subscription has all limit fields
    const subscription = subscriptions[0];
    subscription.subscription_tiers = subscription.subscription_tiers || {};
    subscription.subscription_tiers = {
        ...DEFAULT_SUBSCRIPTION_LIMITS,
        ...subscription.subscription_tiers
    };

    return subscription;
}

export async function getOrCreateUsage(userId: string, subscription: SubscriptionData | null): Promise<UsageData> {
    const now = new Date();
    
    // Determine the period
    let periodStart, periodEnd;
    if (subscription) {
        periodStart = new Date(subscription.current_period_start);
        periodEnd = new Date(subscription.current_period_end);
    } else {
        periodStart = new Date(now.getFullYear(), now.getMonth(), 1); // Start of current month
        periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0); // End of current month
    }

    // First try to get existing record
    const { data: existingUsage, error: getError } = await supabaseClient
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .eq('period_start', periodStart.toISOString())
        .single();

    if (getError && getError.message !== 'JSON object requested, multiple (or no) rows returned') {
        console.error('Error fetching usage:', getError);
        throw getError;
    }

    // If record exists, return it with defaults ensured
    if (existingUsage) {
        return {
            ...existingUsage,
            realtime_sessions_started: existingUsage.realtime_sessions_started || 0,
            voice_evaluations_used: existingUsage.voice_evaluations_used || 0,
            card_audio_generations_used: existingUsage.card_audio_generations_used || 0
        };
    }

    // If no record exists, create one with zeroed usage
    const { data: newUsage, error: createError } = await supabaseClient
        .from('usage_tracking')
        .insert({
            user_id: userId,
            realtime_sessions_started: 0,
            voice_evaluations_used: 0,
            card_audio_generations_used: 0,
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString()
        })
        .select()
        .single();

    if (createError) {
        console.error('Error creating usage tracking:', createError);
        throw createError;
    }

    return newUsage;
}

export async function updateUsage(usageId: string, updates: Partial<UsageData>) {
    const { error } = await supabaseClient
        .from('usage_tracking')
        .update(updates)
        .eq('id', usageId);

    if (error) {
        console.error('Error updating usage:', error);
        throw error;
    }
}

export function checkUsageLimits(usage: UsageData, subscription: SubscriptionData | null, usageField: string) {
    if (!subscription) return; // No limits for free tier

    const limit = subscription.subscription_tiers[usageField + '_limit'];
    const used = usage[usageField];

    if (limit !== -1 && used >= limit) {
        throw new Error(`Usage limit exceeded for ${usageField}`);
    }
} 