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
    
    // Get the customer ID from the session
    const stripeCustomerId = session.customer;
    if (!stripeCustomerId) {
      log(`[${requestId}] No customer ID found in checkout session`);
      return;
    }
    
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
    
    // Get the price ID from the subscription
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (!priceId) {
      log(`[${requestId}] No price ID found in subscription items`);
      return;
    }
    
    log(`[${requestId}] Subscription has price ID: ${priceId}`);
    
    // Process the subscription with the extracted customer ID and price ID
    await processSubscription(stripeCustomerId, priceId, subscription, requestId);
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
    
    // Get the Stripe customer ID from the subscription
    const stripeCustomerId = subscription.customer;
    if (!stripeCustomerId) {
      log(`[${requestId}] No customer ID found in subscription`);
      return;
    }
    
    // Get the price ID from the subscription items
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (!priceId) {
      log(`[${requestId}] No price ID found in subscription items`);
      return;
    }
    
    log(`[${requestId}] Subscription details - Customer: ${stripeCustomerId}, Price: ${priceId}`);
    
    // Process the subscription with the extracted customer ID and price ID
    await processSubscription(stripeCustomerId, priceId, subscription, requestId);
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
    
    // Find the user by Stripe customer ID
    const stripeCustomerId = subscription.customer;
    if (!stripeCustomerId) {
      log(`[${requestId}] No customer ID found in subscription`);
      return;
    }
    
    log(`[${requestId}] Finding user subscription by customer ID: ${stripeCustomerId}`);
    const { data: userSubscription, error: findError } = await supabaseClient
      .from('user_subscriptions')
      .select('*')
      .eq('stripe_customer_id', stripeCustomerId)
      .single();
      
    if (findError) {
      log(`[${requestId}] Error finding subscription: ${findError.message}`, findError);
      return;
    }
    
    log(`[${requestId}] Found subscription: ${userSubscription.id} for user: ${userSubscription.user_id}`);
    
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
  
  // Get customer ID from invoice
  const stripeCustomerId = invoice.customer;
  if (!stripeCustomerId) {
    log(`[${requestId}] No customer ID found in invoice`);
    return;
  }
  
  // Update subscription status if needed
  if (invoice.subscription) {
    log(`[${requestId}] Updating subscription status to active for customer: ${stripeCustomerId}`);
    try {
      // Find user subscription by customer ID
      const { data: userSubscription, error: findError } = await supabaseClient
        .from('user_subscriptions')
        .select('id')
        .eq('stripe_customer_id', stripeCustomerId)
        .single();
        
      if (findError) {
        log(`[${requestId}] Error finding subscription by customer ID: ${findError.message}`, findError);
        return;
      }
      
      log(`[${requestId}] Found subscription: ${userSubscription.id}`);
      
      // Update subscription status
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({ status: 'active' })
        .eq('id', userSubscription.id);
        
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
  
  // Get customer ID from invoice
  const stripeCustomerId = invoice.customer;
  if (!stripeCustomerId) {
    log(`[${requestId}] No customer ID found in invoice`);
    return;
  }
  
  // Update subscription status to reflect payment failure
  if (invoice.subscription) {
    log(`[${requestId}] Updating subscription status to past_due for customer: ${stripeCustomerId}`);
    try {
      // Find user subscription by customer ID
      const { data: userSubscription, error: findError } = await supabaseClient
        .from('user_subscriptions')
        .select('id')
        .eq('stripe_customer_id', stripeCustomerId)
        .single();
        
      if (findError) {
        log(`[${requestId}] Error finding subscription by customer ID: ${findError.message}`, findError);
        return;
      }
      
      log(`[${requestId}] Found subscription: ${userSubscription.id}`);
      
      // Update subscription status
      const { error } = await supabaseClient
        .from('user_subscriptions')
        .update({ status: 'past_due' })
        .eq('id', userSubscription.id);
        
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

// Shared function to process subscriptions
async function processSubscription(stripeCustomerId, priceId, subscription, requestId) {
  // Find tier by price ID
  log(`[${requestId}] Looking up tier by price ID: ${priceId}`);
  const { data: tierData, error: tierError } = await supabaseClient
    .from('subscription_tiers')
    .select('id')
    .eq('stripe_price_id', priceId)
    .single();
    
  if (tierError) {
    log(`[${requestId}] Error finding tier by price ID: ${tierError.message}`, tierError);
    return;
  }
  
  const tierId = tierData.id;
  log(`[${requestId}] Found tier ID: ${tierId}`);
  
  // Find user subscription by Stripe customer ID
  log(`[${requestId}] Looking for user by Stripe customer ID: ${stripeCustomerId}`);
  const { data: userSubscription, error: findError } = await supabaseClient
    .from('user_subscriptions')
    .select('*')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();
    
  if (findError) {
    log(`[${requestId}] Error finding user by customer ID: ${findError.message}`, findError);
    return;
  }
  
  // Update the subscription record
  log(`[${requestId}] Found user subscription: ${userSubscription.id} for user: ${userSubscription.user_id}`);
  const updateData = {
    stripe_subscription_id: subscription.id,
    current_period_start: new Date(subscription.current_period_start * 1000).toISOString(),
    current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
    status: subscription.status,
    tier_id: tierId
  };
  
  log(`[${requestId}] Update data:`, updateData);
  const { error } = await supabaseClient
    .from('user_subscriptions')
    .update(updateData)
    .eq('id', userSubscription.id);
    
  if (error) {
    log(`[${requestId}] Error updating subscription: ${error.message}`, error);
    throw error;
  }
  
  log(`[${requestId}] Subscription updated successfully`);
}