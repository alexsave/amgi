import { supabaseAdmin } from "./supabase.ts";

export interface UsageData {
    id: string;
    user_id: string;
    realtime_sessions_started: number;
    voice_evaluations_used: number;
    card_audio_generations_used: number;
}

export interface SubscriptionTier {
    id: string;
    name: string;
    realtime_sessions_limit: number;
    voice_evaluations_limit: number;
    card_audio_generations_limit: number;
}

export interface SubscriptionData {
    id: string;
    user_id: string;
    tier_id: string;
    current_period_start: string;
    current_period_end: string;
    status?: string;
    subscription_tier: SubscriptionTier;
}

export type UsageField =
    | 'realtime_sessions_started'
    | 'voice_evaluations_used'
    | 'card_audio_generations_used';

const LIMIT_FIELD: Record<UsageField, keyof SubscriptionTier> = {
    realtime_sessions_started: 'realtime_sessions_limit',
    voice_evaluations_used: 'voice_evaluations_limit',
    card_audio_generations_used: 'card_audio_generations_limit',
};

const DEFAULT_SUBSCRIPTION_TIER: SubscriptionTier = {
    id: 'free',
    name: 'Free',
    realtime_sessions_limit: 0,
    voice_evaluations_limit: 0,
    card_audio_generations_limit: 0
};

/**
 * Returns subscription data for a user, falling back to a synthetic free
 * subscription when none exists yet.
 */
export async function getSubscription(userId: string): Promise<SubscriptionData | null> {
    const { data: userSubscription, error: subError } = await supabaseAdmin
        .from('user_subscriptions')
        .select('id, user_id, tier_id, current_period_start, current_period_end, status')
        .eq('user_id', userId)
        .single();

    if (subError) {
        // PGRST116 = no rows; treat as an implicit free subscription.
        if (subError.code === 'PGRST116') {
            const now = new Date();
            return {
                id: 'free',
                user_id: userId,
                tier_id: 'free',
                current_period_start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
                current_period_end: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
                status: 'active',
                subscription_tier: DEFAULT_SUBSCRIPTION_TIER
            };
        }
        throw subError;
    }

    const { data: tierData, error: tierError } = await supabaseAdmin
        .from('subscription_tiers')
        .select('*')
        .eq('id', userSubscription.tier_id)
        .single();

    if (tierError) {
        console.warn('[billing] tier lookup failed, using free tier:', tierError.message);
        return { ...userSubscription, subscription_tier: DEFAULT_SUBSCRIPTION_TIER };
    }

    return { ...userSubscription, subscription_tier: tierData };
}

/**
 * Gets the usage record for a user (created by trigger on signup).
 */
export async function getUsage(userId: string): Promise<UsageData> {
    const { data: usage, error } = await supabaseAdmin
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (error) throw error;
    return usage;
}

/**
 * Resets all usage counters to zero for a user (used on billing-period roll).
 */
export async function resetUsage(userId: string): Promise<UsageData> {
    const { data: updatedUsage, error } = await supabaseAdmin
        .from('usage_tracking')
        .update({
            realtime_sessions_started: 0,
            voice_evaluations_used: 0,
            card_audio_generations_used: 0
        })
        .eq('user_id', userId)
        .select()
        .single();

    if (error) throw error;
    return updatedUsage;
}

/**
 * Checks if usage is within limits for a specific feature.
 */
export function checkUsageLimits(
    usage: UsageData,
    subscription: SubscriptionData | null,
    usageField: UsageField
): boolean {
    if (!subscription) return false;
    if (subscription.status === 'past_due') return false;
    if (!subscription.subscription_tier) return false;

    const limit = subscription.subscription_tier[LIMIT_FIELD[usageField]] as number;
    const used = usage[usageField] as number;

    // Unlimited (-1) or within limits
    return limit === -1 || used < limit;
}

/**
 * Checks if a user can perform an action based on their subscription limits,
 * and if allowed, increments their usage counter.
 *
 * Uses the atomic `check_and_increment_usage` RPC (single UPDATE guarded by
 * the limit, so concurrent requests can't overshoot). Falls back to the
 * legacy read-modify-write path when the RPC hasn't been migrated in yet.
 */
export async function checkAndIncrementUsage(
    userId: string,
    usageField: UsageField,
    incrementAmount: number = 1
): Promise<{ allowed: boolean; usage: UsageData; subscription: SubscriptionData | null }> {
    const subscription = await getSubscription(userId);
    const blocked = !subscription
        || subscription.status === 'past_due'
        || !subscription.subscription_tier;

    if (blocked) {
        return { allowed: false, usage: await getUsage(userId), subscription };
    }

    const { data, error } = await supabaseAdmin.rpc('check_and_increment_usage', {
        p_user_id: userId,
        p_field: usageField,
        p_amount: incrementAmount,
        p_limit: subscription!.subscription_tier[LIMIT_FIELD[usageField]],
    });

    if (error) {
        // RPC missing (migration not applied yet) — fall back to non-atomic path.
        if (error.code === 'PGRST202' || error.code === '42883') {
            return checkAndIncrementUsageLegacy(userId, usageField, incrementAmount, subscription);
        }
        throw error;
    }

    return { allowed: data.allowed, usage: data.usage, subscription };
}

async function checkAndIncrementUsageLegacy(
    userId: string,
    usageField: UsageField,
    incrementAmount: number,
    subscription: SubscriptionData | null,
): Promise<{ allowed: boolean; usage: UsageData; subscription: SubscriptionData | null }> {
    const usage = await getUsage(userId);
    const allowed = checkUsageLimits(usage, subscription, usageField);

    if (!allowed) {
        return { allowed: false, usage, subscription };
    }

    if (incrementAmount > 0) {
        const newValue = (usage[usageField] || 0) + incrementAmount;
        const { error } = await supabaseAdmin
            .from('usage_tracking')
            .update({ [usageField]: newValue })
            .eq('id', usage.id);

        if (error) throw error;
        usage[usageField] = newValue;
    }

    return { allowed: true, usage, subscription };
}
