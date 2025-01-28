import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? ''
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

export async function getSubscription(userId: string): Promise<SubscriptionData | null> {
    const enableBilling = Deno.env.get('ENABLE_BILLING') === 'true';
    if (!enableBilling) {
        return null;
    }

    const { data: sub, error: subError } = await supabase
        .from('user_subscriptions')
        .select('*, subscription_tiers(*)')
        .eq('user_id', userId)
        .single();

    if (subError) {
        throw subError;
    }
    return sub;
}

export async function getOrCreateUsage(userId: string, subscription: SubscriptionData | null): Promise<UsageData> {
    const now = new Date();
    const { data: usage, error: usageError } = await supabase
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .lte('period_end', now.toISOString())
        .gte('period_start', now.toISOString())
        .single();

    if (!usageError) {
        return usage;
    }

    if (usageError.message !== 'JSON object requested, multiple (or no) rows returned') {
        throw usageError;
    }

    // Create new usage record
    let periodStart: Date, periodEnd: Date;
    if (subscription) {
        periodStart = new Date(subscription.current_period_start);
        periodEnd = new Date(subscription.current_period_end);
    } else {
        periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    }

    const { data: newUsage, error: createError } = await supabase
        .from('usage_tracking')
        .insert({
            user_id: userId,
            voice_evaluations_used: 0,
            realtime_sessions_started: 0,
            card_audio_generations_used: 0,
            period_start: periodStart.toISOString(),
            period_end: periodEnd.toISOString()
        })
        .select()
        .single();

    if (createError) {
        throw createError;
    }

    return newUsage;
}

export async function updateUsage(usageId: string, updates: Partial<UsageData>) {
    const { error } = await supabase
        .from('usage_tracking')
        .update(updates)
        .eq('id', usageId);

    if (error) {
        throw error;
    }
}

export function checkUsageLimits(usage: UsageData, subscription: SubscriptionData | null, type: keyof UsageData) {
    if (!subscription) {
        return;
    }

    const limitField = type.replace('_used', '_limit') as keyof SubscriptionData['subscription_tiers'];
    const limit = subscription.subscription_tiers[limitField];
    const used = usage[type] as number;

    if (limit !== -1 && used >= limit) {
        throw new Error(`You have reached your ${type.replace('_used', '')} limit for this billing period`);
    }
} 