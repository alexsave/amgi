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

// Simple logging function to include timestamps
function log(message: string, data?: any) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

serve(async (req) => {
  const requestId = crypto.randomUUID();
  log(`[${requestId}] Webhook request received`, {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries())
  });
  
  const signature = req.headers.get('stripe-signature');
  
  if (!signature) {
    log(`[${requestId}] Missing stripe-signature header`);
    return new Response(
      JSON.stringify({ error: 'Missing stripe-signature header' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  
  try {
    // Get the raw request body
    log(`[${requestId}] Reading request body`);
    const body = await req.text();
    log(`[${requestId}] Body length: ${body.length} bytes`);
    
    // Construct the event
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
    log(`[${requestId}] Verifying webhook signature with secret: ${webhookSecret ? 'present' : 'missing'}`);
    log(`[${requestId}] Stripe signature: ${signature.substring(0, 20)}...`);
    
    try {
      const event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
      log(`[${requestId}] Event successfully constructed`, { 
        type: event.type, 
        id: event.id,
        apiVersion: event.api_version
      });
      
      // Log object type
      log(`[${requestId}] Event object type: ${event.data.object.object}`);
      
      // Handle specific events
      switch (event.type) {
        case 'checkout.session.completed': {
          log(`[${requestId}] Processing checkout.session.completed event`);
          const session = event.data.object;
          log(`[${requestId}] Checkout session details`, {
            id: session.id,
            customer: session.customer,
            subscription: session.subscription,
            metadata: session.metadata
          });
          
          await handleCheckoutSessionCompleted(session, requestId);
          break;
        }
          
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          log(`[${requestId}] Processing ${event.type} event`);
          const subscription = event.data.object;
          log(`[${requestId}] Subscription details`, {
            id: subscription.id,
            status: subscription.status,
            customer: subscription.customer,
            current_period_start: subscription.current_period_start,
            current_period_end: subscription.current_period_end
          });
          
          await handleSubscriptionUpdated(subscription, requestId);
          break;
        }
          
        case 'customer.subscription.deleted': {
          log(`[${requestId}] Processing customer.subscription.deleted event`);
          const subscription = event.data.object;
          log(`[${requestId}] Deleted subscription details`, {
            id: subscription.id,
            customer: subscription.customer
          });
          
          await handleSubscriptionDeleted(subscription, requestId);
          break;
        }
          
        case 'invoice.payment_succeeded': {
          log(`[${requestId}] Processing invoice.payment_succeeded event`);
          const invoice = event.data.object;
          log(`[${requestId}] Invoice details`, {
            id: invoice.id,
            subscription: invoice.subscription,
            customer: invoice.customer,
            status: invoice.status,
            total: invoice.total
          });
          
          await handleInvoicePaymentSucceeded(invoice, requestId);
          break;
        }
          
        case 'invoice.payment_failed': {
          log(`[${requestId}] Processing invoice.payment_failed event`);
          const invoice = event.data.object;
          log(`[${requestId}] Failed invoice details`, {
            id: invoice.id,
            subscription: invoice.subscription,
            customer: invoice.customer,
            attempt_count: invoice.attempt_count
          });
          
          await handleInvoicePaymentFailed(invoice, requestId);
          break;
        }
          
        default:
          log(`[${requestId}] Unhandled event type: ${event.type}`);
      }
      
      log(`[${requestId}] Event processed successfully`);
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    } catch (verifyError) {
      log(`[${requestId}] Signature verification failed: ${verifyError.message}`, {
        error: verifyError,
        stack: verifyError.stack
      });
      throw verifyError; // Re-throw to be caught by outer try/catch
    }
  } catch (err) {
    log(`[${requestId}] Webhook error: ${err.message}`, {
      error: err,
      stack: err.stack
    });
    return new Response(
      JSON.stringify({ error: `Webhook Error: ${err.message}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

// Handler for checkout.session.completed event
async function handleCheckoutSessionCompleted(session, requestId) {
  try {
    log(`[${requestId}] Beginning checkout session processing`);
    
    // Check if session has subscription
    if (!session.subscription) {
      log(`[${requestId}] No subscription found in checkout session`);
      return;
    }
    
    // Retrieve the subscription
    log(`[${requestId}] Retrieving subscription: ${session.subscription}`);
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    log(`[${requestId}] Retrieved subscription details`, {
      status: subscription.status,
      items: subscription.items.data.length,
      plan: subscription.items.data[0]?.plan?.id
    });
    
    // Get user ID from the session metadata
    const userId = session.metadata.user_id;
    const tierId = session.metadata.tier_id;
    
    if (!userId) {
      log(`[${requestId}] No user_id found in session metadata`);
      return;
    }
    
    if (!tierId) {
      log(`[${requestId}] No tier_id found in session metadata`);
      return;
    }
    
    log(`[${requestId}] Processing for user ${userId}, tier ${tierId}`);
    
    // Check if a subscription record already exists for this user
    log(`[${requestId}] Checking for existing subscription for user: ${userId}`);
    const { data: existingSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .single();
      
    if (findError) {
      log(`[${requestId}] Error finding existing subscription: ${findError.message}`, {
        code: findError.code,
        details: findError.details
      });
      
      if (findError.code !== 'PGRST116') {
        throw findError;
      } else {
        log(`[${requestId}] No existing subscription found (expected)`);
      }
    } else {
      log(`[${requestId}] Found existing subscription`, {
        id: existingSubscription.id,
        status: existingSubscription.status,
        tier_id: existingSubscription.tier_id
      });
    }
    
    const subscriptionData = {
      stripe_subscription_id: subscription.id,
      stripe_customer_id: subscription.customer,
      current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      status: subscription.status,
      tier_id: tierId,
    };
    
    log(`[${requestId}] Preparing subscription data`, subscriptionData);
    
    if (existingSubscription) {
      // Update existing subscription
      log(`[${requestId}] Updating existing subscription: ${existingSubscription.id}`);
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update(subscriptionData)
        .eq('id', existingSubscription.id);
        
      if (error) {
        log(`[${requestId}] Error updating subscription: ${error.message}`, error);
        throw error;
      }
      
      log(`[${requestId}] Subscription updated successfully`);
    } else {
      // Create new subscription record
      log(`[${requestId}] Creating new subscription record for user: ${userId}`);
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .insert({
          ...subscriptionData,
          user_id: userId,
        });
        
      if (error) {
        log(`[${requestId}] Error creating subscription: ${error.message}`, error);
        throw error;
      }
      
      log(`[${requestId}] New subscription created successfully`);
    }
  } catch (error) {
    log(`[${requestId}] Error processing checkout session: ${error.message}`, {
      error: error,
      stack: error.stack
    });
    throw error;
  }
}

// Handler for customer.subscription.updated event
async function handleSubscriptionUpdated(subscription, requestId) {
  try {
    log(`[${requestId}] Handling subscription update: ${subscription.id}`);
    
    // Find user subscription by Stripe subscription ID
    log(`[${requestId}] Looking for existing subscription with stripe_subscription_id: ${subscription.id}`);
    const { data: userSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*')
      .eq('stripe_subscription_id', subscription.id)
      .single();
      
    if (findError) {
      log(`[${requestId}] Subscription not found by ID, error: ${findError.message}`);
      
      // If not found by subscription ID, try to find by customer ID
      log(`[${requestId}] Trying to find by customer ID: ${subscription.customer}`);
      const { data: userSubByCustomer, error: customerFindError } = await supabaseClient
        .from('user_subscriptions')
        .select('*')
        .eq('stripe_customer_id', subscription.customer)
        .single();
        
      if (customerFindError) {
        log(`[${requestId}] Subscription not found by customer ID either: ${customerFindError.message}`);
        console.error('Subscription not found in database');
        return;
      }
      
      log(`[${requestId}] Found subscription by customer ID: ${userSubByCustomer.id}`);
      
      // Update the subscription record with the subscription ID
      log(`[${requestId}] Updating subscription ${userSubByCustomer.id} with new subscription ID`);
      const updateData = {
        stripe_subscription_id: subscription.id,
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        status: subscription.status,
      };
      
      log(`[${requestId}] Update data:`, updateData);
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update(updateData)
        .eq('id', userSubByCustomer.id);
        
      if (error) {
        log(`[${requestId}] Error updating subscription: ${error.message}`, error);
        throw error;
      }
      
      log(`[${requestId}] Subscription updated successfully with new subscription ID`);
    } else {
      // Update the existing subscription record
      log(`[${requestId}] Found existing subscription: ${userSubscription.id}`);
      const updateData = {
        current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        status: subscription.status,
      };
      
      log(`[${requestId}] Update data:`, updateData);
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update(updateData)
        .eq('id', userSubscription.id);
        
      if (error) {
        log(`[${requestId}] Error updating existing subscription: ${error.message}`, error);
        throw error;
      }
      
      log(`[${requestId}] Existing subscription updated successfully`);
    }
  } catch (error) {
    log(`[${requestId}] Error updating subscription: ${error.message}`, {
      stack: error.stack,
      error: error
    });
    throw error;
  }
}

// Handler for customer.subscription.deleted event
async function handleSubscriptionDeleted(subscription, requestId) {
  try {
    log(`[${requestId}] Processing subscription deletion: ${subscription.id}`);
    
    // Find the subscription in our database
    log(`[${requestId}] Finding subscription in database by stripe_subscription_id: ${subscription.id}`);
    const { data: userSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*, subscription_tiers(name)')
      .eq('stripe_subscription_id', subscription.id)
      .single();
      
    if (findError) {
      log(`[${requestId}] Error finding subscription: ${findError.message}`, findError);
      console.error('Subscription not found in database');
      return;
    }
    
    log(`[${requestId}] Found subscription: ${userSubscription.id}`);
    
    // Get the free tier ID
    log(`[${requestId}] Looking up Free tier ID`);
    const { data: freeTier, error: tierError } = await supabaseClient
      .from('subscription_tiers')
      .select('id')
      .eq('name', 'Free')
      .single();
      
    if (tierError) {
      log(`[${requestId}] Error finding Free tier: ${tierError.message}`, tierError);
      throw tierError;
    }
    
    log(`[${requestId}] Found Free tier: ${freeTier.id}`);
    
    // Update user subscription to free tier
    log(`[${requestId}] Downgrading user to Free tier`);
    const updateData = {
      tier_id: freeTier.id,
      status: 'canceled',
      stripe_subscription_id: null,
    };
    
    log(`[${requestId}] Update data:`, updateData);
    const { error } = await supabaseClient
      .from('user_subscriptions')
      .update(updateData)
      .eq('id', userSubscription.id);
      
    if (error) {
      log(`[${requestId}] Error downgrading subscription: ${error.message}`, error);
      throw error;
    }
    
    log(`[${requestId}] Subscription successfully downgraded to Free tier`);
  } catch (error) {
    log(`[${requestId}] Error handling subscription deletion: ${error.message}`, {
      stack: error.stack,
      error: error
    });
    throw error;
  }
}

// Handler for invoice.payment_succeeded event
async function handleInvoicePaymentSucceeded(invoice, requestId) {
  log(`[${requestId}] Processing invoice payment success: ${invoice.id}`);
  
  // Update subscription status if needed
  if (invoice.subscription) {
    log(`[${requestId}] Updating subscription status to active: ${invoice.subscription}`);
    try {
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({ status: 'active' })
        .eq('stripe_subscription_id', invoice.subscription);
        
      if (error) {
        log(`[${requestId}] Error updating subscription status: ${error.message}`, error);
        throw error;
      }
      
      log(`[${requestId}] Subscription status updated to active`);
    } catch (error) {
      log(`[${requestId}] Error updating subscription after payment: ${error.message}`, {
        stack: error.stack,
        error: error
      });
      throw error;
    }
  } else {
    log(`[${requestId}] No subscription found in invoice, skipping status update`);
  }
}

// Handler for invoice.payment_failed event
async function handleInvoicePaymentFailed(invoice, requestId) {
  log(`[${requestId}] Processing invoice payment failure: ${invoice.id}`);
  
  // Update subscription status to reflect payment failure
  if (invoice.subscription) {
    log(`[${requestId}] Updating subscription status to past_due: ${invoice.subscription}`);
    try {
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({ status: 'past_due' })
        .eq('stripe_subscription_id', invoice.subscription);
        
      if (error) {
        log(`[${requestId}] Error updating subscription status: ${error.message}`, error);
        throw error;
      }
      
      log(`[${requestId}] Subscription status updated to past_due`);
    } catch (error) {
      log(`[${requestId}] Error updating subscription after payment failure: ${error.message}`, {
        stack: error.stack,
        error: error
      });
      throw error;
    }
  } else {
    log(`[${requestId}] No subscription found in invoice, skipping status update`);
  }
} 