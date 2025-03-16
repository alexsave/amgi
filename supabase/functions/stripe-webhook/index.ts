import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import Stripe from "https://esm.sh/stripe@12.6.0?target=deno";

// Initialize Stripe
const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2023-10-16',
});

// Initialize Supabase client
const supabaseClient = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  
  if (!signature) {
    return new Response(
      JSON.stringify({ error: 'Missing stripe-signature header' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  try {
    // Get the raw request body
    const body = await req.text();
    
    // Construct the event
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    const event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
    
    // Handle specific events
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutSessionCompleted(session);
        break;
      }
        
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        await handleSubscriptionUpdated(subscription);
        break;
      }
        
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        await handleSubscriptionDeleted(subscription);
        break;
      }
        
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        await handleInvoicePaymentSucceeded(invoice);
        break;
      }
        
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await handleInvoicePaymentFailed(invoice);
        break;
      }
        
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
    
    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    console.error(`Webhook error: ${err.message}`);
    return new Response(
      JSON.stringify({ error: `Webhook Error: ${err.message}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

// Handler for checkout.session.completed event
async function handleCheckoutSessionCompleted(session) {
  try {
    // Retrieve the subscription
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    
    // Get user ID from the session metadata
    const userId = session.metadata.user_id;
    const tierId = session.metadata.tier_id;
    
    // Check if a subscription record already exists for this user
    const { data: existingSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();
      
    if (findError && findError.code !== 'PGRST116') {
      throw findError;
    }
    
    const subscriptionData = {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      status: subscription.status,
      tier_id: tierId,
    };
    
    if (existingSubscription) {
      // Update existing subscription
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update(subscriptionData)
        .eq('id', existingSubscription.id);
        
      if (error) throw error;
    } else {
      // Create new subscription record
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .insert({
          ...subscriptionData,
          user_id: userId,
        });
        
      if (error) throw error;
    }
  } catch (error) {
    console.error('Error processing checkout session:', error);
    throw error;
  }
}

// Handler for customer.subscription.updated event
async function handleSubscriptionUpdated(subscription) {
  try {
    // Find user subscription by Stripe subscription ID
    const { data: userSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*')
      .eq('stripe_subscription_id', subscription.id)
      .single();
      
    if (findError) {
      // If not found by subscription ID, try to find by customer ID
      const { data: userSubByCustomer, error: customerFindError } = await supabaseClient
        .from('user_subscriptions')
        .select('*')
        .eq('stripe_customer_id', subscription.customer)
        .single();
        
      if (customerFindError) {
        console.error('Subscription not found in database');
        return;
      }
      
      // Update the subscription record with the subscription ID
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({
          stripe_subscription_id: subscription.id,
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          status: subscription.status,
        })
        .eq('id', userSubByCustomer.id);
        
      if (error) throw error;
    } else {
      // Update the existing subscription record
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({
          current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          status: subscription.status,
        })
        .eq('id', userSubscription.id);
        
      if (error) throw error;
    }
  } catch (error) {
    console.error('Error updating subscription:', error);
    throw error;
  }
}

// Handler for customer.subscription.deleted event
async function handleSubscriptionDeleted(subscription) {
  try {
    // Find the subscription in our database
    const { data: userSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*, subscription_tiers(name)')
      .eq('stripe_subscription_id', subscription.id)
      .single();
      
    if (findError) {
      console.error('Subscription not found in database');
      return;
    }
    
    // Get the free tier ID
    const { data: freeTier, error: tierError } = await supabaseClient
      .from('subscription_tiers')
      .select('id')
      .eq('name', 'Free')
      .single();
      
    if (tierError) throw tierError;
    
    // Update user subscription to free tier
    const { error } = await supabaseClient
      .from('user_subscriptions')
      .update({
        tier_id: freeTier.id,
        status: 'canceled',
        stripe_subscription_id: null,
      })
      .eq('id', userSubscription.id);
      
    if (error) throw error;
  } catch (error) {
    console.error('Error handling subscription deletion:', error);
    throw error;
  }
}

// Handler for invoice.payment_succeeded event
async function handleInvoicePaymentSucceeded(invoice) {
  // Update subscription status if needed
  if (invoice.subscription) {
    try {
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({ status: 'active' })
        .eq('stripe_subscription_id', invoice.subscription);
        
      if (error) throw error;
    } catch (error) {
      console.error('Error updating subscription after payment:', error);
      throw error;
    }
  }
}

// Handler for invoice.payment_failed event
async function handleInvoicePaymentFailed(invoice) {
  // Update subscription status to reflect payment failure
  if (invoice.subscription) {
    try {
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({ status: 'past_due' })
        .eq('stripe_subscription_id', invoice.subscription);
        
      if (error) throw error;
    } catch (error) {
      console.error('Error updating subscription after payment failure:', error);
      throw error;
    }
  }
} 