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

const DEFAULT_SUBSCRIPTION_TIER: SubscriptionTier = {
    id: 'free',
    name: 'Free',
    realtime_sessions_limit: 0,
    voice_evaluations_limit: 0,
    card_audio_generations_limit: 0
};

/**
 * Returns subscription data for a user
 */
export async function getSubscription(userId: string): Promise<SubscriptionData | null> {
    console.log(`[BILLING] Getting subscription for user ${userId}`);
    
    // First, get the user subscription
    const { data: userSubscription, error: subError } = await supabaseClient
        .from('user_subscriptions')
        .select('id, user_id, tier_id, current_period_start, current_period_end, status')
        .eq('user_id', userId)
        .single();

    if (subError) {
        console.error('[BILLING] Error fetching subscription:', subError);
        // If no subscription found, create a default free one
        if (subError.code === 'PGRST116') { // Supabase "not found" error code
            console.log(`[BILLING] No subscription found, creating default free subscription`);
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

    console.log(`[BILLING] User subscription found:`, userSubscription);
    console.log(`[BILLING] Tier ID to look up:`, userSubscription.tier_id);

    // Now get the tier details
    const { data: tierData, error: tierError } = await supabaseClient
        .from('subscription_tiers')
        .select('*')  // Select all fields to ensure we get everything
        .eq('id', userSubscription.tier_id)
        .single();
    
    if (tierError) {
        console.error('[BILLING] Error fetching subscription tier:', tierError);
        console.warn('[BILLING] Using default subscription tier');
        return {
            ...userSubscription,
            subscription_tier: DEFAULT_SUBSCRIPTION_TIER
        };
    }

    console.log(`[BILLING] Retrieved tier data:`, tierData);
    console.log(`[BILLING] Audio limit in tier:`, tierData.card_audio_generations_limit);

    // Combine the data
    const subscription: SubscriptionData = {
        ...userSubscription,
        subscription_tier: tierData
    };

    console.log(`[BILLING] Final subscription object:`, subscription);
    console.log(`[BILLING] Audio limit in final object:`, subscription.subscription_tier.card_audio_generations_limit);
    
    return subscription;
}

/**
 * Gets the usage record for a user, which should always exist due to the trigger
 * that creates it when a user is created
 */
export async function getUsage(userId: string): Promise<UsageData> {
    console.log(`[BILLING] Getting usage record for user ${userId}`);
    
    // Get the user's usage record - there should only be one per user
    const { data: usage, error } = await supabaseClient
        .from('usage_tracking')
        .select('*')
        .eq('user_id', userId)
        .single();

    if (error) {
        console.error('[BILLING] Error fetching usage:', error);
        throw error;
    }

    console.log(`[BILLING] Retrieved usage record:`, usage);
    return usage;
}

/**
 * Resets all usage counters to zero for a user
 */
export async function resetUsage(userId: string): Promise<UsageData> {
    const { data: updatedUsage, error } = await supabaseClient
        .from('usage_tracking')
        .update({
            realtime_sessions_started: 0,
            voice_evaluations_used: 0,
            card_audio_generations_used: 0
        })
        .eq('user_id', userId)
        .select()
        .single();
        
    if (error) {
        console.error('Error resetting usage:', error);
        throw error;
    }
    
    return updatedUsage;
}

/**
 * Updates usage data
 */
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

/**
 * Simple check if usage exceeds limits for a specific feature
 */
export function checkUsageLimits(
    usage: UsageData, 
    subscription: SubscriptionData | null, 
    usageField: string
): boolean {
    console.log(`[BILLING] Checking usage limits for ${usageField}`);
    
    // No subscription means no access
    if (!subscription) {
        console.log(`[BILLING] No subscription found - access denied`);
        return false;
    }

    // Block usage if past_due
    if (subscription.status === 'past_due') {
        console.log(`[BILLING] Subscription status is past_due - access denied`);
        return false;
    }
    
    if (!subscription.subscription_tier) {
        console.error(`[BILLING] Subscription tier is missing or undefined`);
        return false;
    }
    
    // Direct mapping of usage fields to corresponding limit fields
    let limitField: keyof SubscriptionTier;
    
    if (usageField === 'card_audio_generations_used') {
        limitField = 'card_audio_generations_limit';
    } else if (usageField === 'voice_evaluations_used') {
        limitField = 'voice_evaluations_limit';
    } else if (usageField === 'realtime_sessions_started') {
        limitField = 'realtime_sessions_limit';
    } else {
        console.error(`[BILLING] Unknown usage field: ${usageField}`);
        return false;
    }
    
    console.log(`[BILLING] Looking for limit field: ${limitField}`);
    
    const limit = subscription.subscription_tier[limitField] as number;
    const used = usage[usageField] as number;
    
    console.log(`[BILLING] Usage check: Current usage=${used}, Limit=${limit}`);

    // Unlimited (-1) or within limits
    const isAllowed = limit === -1 || used < limit;
    console.log(`[BILLING] Access ${isAllowed ? 'ALLOWED' : 'DENIED'} (${isAllowed ? 'under limit or unlimited' : 'over limit'})`);
    
    return isAllowed;
}

/**
 * Performs all billing setup for a user request
 */
export async function setupBilling(
    userId: string, 
    usageField?: keyof UsageData
): Promise<{ 
    subscription: SubscriptionData | null; 
    usage: UsageData;
    isAllowed?: boolean;
}> {
    // Get subscription data
    const subscription = await getSubscription(userId);
    
    // Get the user's usage tracking record
    const usage = await getUsage(userId);
    
    // Check limits if a usage field was specified
    let isAllowed;
    if (usageField && subscription) {
        isAllowed = checkUsageLimits(usage, subscription, usageField);
    }
    
    return { subscription, usage, isAllowed };
}

/**
 * Increments a specific usage counter for a user
 */
export async function incrementUsage(
    usageId: string, 
    usageField: keyof UsageData, 
    incrementAmount: number = 1
): Promise<number> {
    console.log(`[BILLING] Incrementing ${usageField} by ${incrementAmount} for usage ID ${usageId}`);
    
    // Get current value first
    const { data: currentUsage, error: getError } = await supabaseClient
        .from('usage_tracking')
        .select(usageField)
        .eq('id', usageId)
        .single();
        
    if (getError) {
        console.error(`[BILLING] Error fetching current ${usageField} value:`, getError);
        throw getError;
    }
    
    const currentValue = currentUsage[usageField] || 0;
    const newValue = currentValue + incrementAmount;
    
    console.log(`[BILLING] Usage increment: ${usageField} ${currentValue} → ${newValue}`);
    
    // Create an update object with just the field to update
    const updateData: Partial<UsageData> = {};
    updateData[usageField] = newValue;
    
    // Update the usage
    await updateUsage(usageId, updateData);
    
    return newValue;
}

/**
 * Checks if a user can perform an action based on their subscription limits,
 * and if allowed, increments their usage counter.
 */
export async function checkAndIncrementUsage(
    userId: string,
    usageField: keyof UsageData,
    incrementAmount: number = 1
): Promise<{ allowed: boolean; usage: UsageData; subscription: SubscriptionData | null }> {
    console.log(`[BILLING] Checking and incrementing ${usageField} for user ${userId}`);
    
    // Get the user's subscription
    const subscription = await getSubscription(userId);
    
    // Get the user's usage tracking record
    const usage = await getUsage(userId);
    
    // Check usage limits
    const allowed = checkUsageLimits(usage, subscription, usageField);
    
    // If not allowed, return blocked result
    if (!allowed) {
        console.log(`[BILLING] Usage not allowed: ${usageField} - limit reached or exceeded`);
        return { allowed: false, usage, subscription };
    }
    
    // If we're here, usage is allowed - increment counter
    if (incrementAmount > 0) {
        // Increment usage
        try {
            console.log(`[BILLING] Incrementing usage: ${usageField} by ${incrementAmount}`);
            const newValue = await incrementUsage(usage.id, usageField, incrementAmount);
            
            // Update the local usage object with typed field access
            if (usageField === 'realtime_sessions_started') {
                usage.realtime_sessions_started = newValue;
            } else if (usageField === 'voice_evaluations_used') {
                usage.voice_evaluations_used = newValue;
            } else if (usageField === 'card_audio_generations_used') {
                usage.card_audio_generations_used = newValue;
            }
            
            console.log(`[BILLING] Updated usage record:`, usage);
        } catch (error) {
            console.error(`[BILLING] Error incrementing usage:`, error);
            throw error;
        }
    }
    
    return { allowed: true, usage, subscription };
} 