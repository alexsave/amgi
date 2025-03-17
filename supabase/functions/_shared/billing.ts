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
        realtime_sessions_limit: number;
        voice_evaluations_limit: number;
        card_audio_generations_limit: number;
    };
}

const DEFAULT_SUBSCRIPTION_LIMITS = {
    realtime_sessions_limit: 0,
    voice_evaluations_limit: 0,
    card_audio_generations_limit: 0
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

/**
 * Performs all billing setup for a user request:
 * 1. Gets the subscription for the user
 * 2. Gets or creates the usage tracking record
 * 3. Optionally checks if the user has exceeded limits for a specific usage type
 * 
 * @param userId The ID of the user
 * @param usageField Optional field name to check limits for
 * @returns An object containing the subscription and usage data
 * @throws Error if the user has exceeded their usage limits
 */
export async function setupBilling(userId: string, usageField?: keyof UsageData) {
    // Get subscription data
    const subscription = await getSubscription(userId);
    
    // Get or create usage tracking
    const usage = await getOrCreateUsage(userId, subscription);
    
    // Check limits if a usage field was specified
    if (usageField && subscription) {
        const limitField = `${usageField}_limit` as keyof SubscriptionData['subscription_tiers'];
        checkUsageLimits(usage, subscription, usageField);
    }
    
    return { subscription, usage };
}

/**
 * Increments a specific usage counter for a user
 * 
 * @param usageId The ID of the usage tracking record
 * @param usageField The field to increment
 * @param incrementAmount The amount to increment by (defaults to 1)
 * @returns void
 * @throws Error if the update fails
 */
export async function incrementUsage(usageId: string, usageField: keyof UsageData, incrementAmount: number = 1) {
    console.log(`Incrementing ${usageField} for usage record ${usageId} by ${incrementAmount}`);
    
    // Get current value first
    const { data: currentUsage, error: getError } = await supabaseClient
        .from('usage_tracking')
        .select(usageField)
        .eq('id', usageId)
        .single();
        
    if (getError) {
        console.error(`Error fetching current ${usageField} value:`, getError);
        throw getError;
    }
    
    const currentValue = currentUsage[usageField] || 0;
    const newValue = currentValue + incrementAmount;
    console.log(`Updating ${usageField} from ${currentValue} to ${newValue}`);
    
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
 * 
 * @param userId The ID of the user
 * @param usageField The type of usage to check and increment
 * @param incrementAmount The amount to increment usage by (defaults to 1)
 * @param forceIncrement If true, increments usage even if over limit (for features that should track usage but not enforce limits)
 * @returns An object containing whether the action is allowed, and the updated usage data
 */
export async function checkAndIncrementUsage(
    userId: string,
    usageField: keyof UsageData,
    incrementAmount: number = 1,
    forceIncrement: boolean = false
): Promise<{ allowed: boolean; usage: UsageData; subscription: SubscriptionData | null }> {
    console.log(`Checking and incrementing ${usageField} for user ${userId}`);
    
    // Get the user's subscription
    const subscription = await getSubscription(userId);
    console.log(`User subscription:`, {
        tier: subscription?.subscription_tiers ? Object.keys(subscription.subscription_tiers)[0] : 'Free',
        id: subscription?.id
    });
    
    // Get or create usage tracking
    const usage = await getOrCreateUsage(userId, subscription);
    console.log(`Current usage:`, {
        id: usage.id,
        currentUsage: usage[usageField]
    });
    
    // Get the limit field name
    const limitField = `${usageField}_limit` as keyof SubscriptionData['subscription_tiers'];
    
    // Check if the user is at their limit
    const currentUsage = usage[usageField] as number || 0;
    const limit = subscription?.subscription_tiers?.[limitField] as number ?? 0;
    const wouldExceedLimit = limit !== -1 && currentUsage >= limit;
    
    console.log(`Usage check:`, {
        currentUsage,
        limit,
        wouldExceedLimit,
        forceIncrement
    });
    
    // If user is at limit and we're not forcing increment, return not allowed
    if (wouldExceedLimit && !forceIncrement) {
        console.log(`User ${userId} has reached ${usageField} limit of ${limit}`);
        return { 
            allowed: false, 
            usage, 
            subscription 
        };
    }
    
    // If we're here, either the user is under limit or we're forcing increment
    if (incrementAmount > 0) {
        // Increment usage
        try {
            const newValue = await incrementUsage(usage.id, usageField, incrementAmount);
            console.log(`Incremented ${usageField} from ${currentUsage} to ${newValue}`);
            
            // Update the local usage object
            usage[usageField] = newValue as any; // Type assertion needed due to TypeScript limitations
        } catch (error) {
            console.error(`Error incrementing usage:`, error);
            throw error;
        }
    }
    
    return {
        allowed: true,
        usage,
        subscription
    };
} 