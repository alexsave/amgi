/// <reference lib="deno.ns" />
import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { serve } from "std/http/server"
import { createClient } from "npm:@supabase/supabase-js@2.39.0"
import Stripe from "npm:stripe@14.18.0"
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
});

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
  log(`[${requestId}] Payment links function called`, {
    method: req.method,
    url: req.url,
    headers: Object.fromEntries(req.headers.entries())
  });
  
  // Handle CORS
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    log(`[${requestId}] Parsing request body`);
    const requestBody = await req.text();
    log(`[${requestId}] Request body: ${requestBody}`);
    
    const { priceId, userId, tierName } = JSON.parse(requestBody);
    log(`[${requestId}] Parsed parameters`, { priceId, userId, tierName });

    if (!userId || !priceId) {
      log(`[${requestId}] Missing required parameters`, { userId, priceId });
      return new Response(
        JSON.stringify({ error: 'Missing required parameters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get the tier data
    log(`[${requestId}] Fetching tier data for price ID: ${priceId}`);
    const { data: tierData, error: tierError } = await supabaseClient
      .from('subscription_tiers')
      .select('*')
      .eq('stripe_price_id', priceId)
      .single();
      
    if (tierError) {
      log(`[${requestId}] Error fetching tier data: ${tierError.message}`, tierError);
      return new Response(
        JSON.stringify({ error: 'Invalid price ID' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    
    log(`[${requestId}] Found tier data`, tierData);
    
    // Get the app URL from environment variable for success/cancel URLs
    const appUrl = Deno.env.get('APP_URL') || 'http://localhost:3000';
    log(`[${requestId}] Using app URL: ${appUrl}`);
    
    if (tierName === 'Free') {
      log(`[${requestId}] Processing free tier subscription`);
      // For free tier, don't create a Stripe payment link
      // Instead update the user_subscriptions table directly
      
      // First check if user has an existing subscription
      log(`[${requestId}] Checking for existing subscription for user: ${userId}`);
      const { data: existingSubscription, error: subError } = await supabaseClient
        .from('user_subscriptions')
        .select('*')
        .eq('user_id', userId)
        .single();
        
      if (subError) {
        log(`[${requestId}] Error fetching existing subscription: ${subError.message}`, { 
          code: subError.code, 
          details: subError.details 
        });
        
        if (subError.code !== 'PGRST116') {
          throw subError;
        }
      }
      
      if (existingSubscription) {
        log(`[${requestId}] Found existing subscription`, existingSubscription);
      } else {
        log(`[${requestId}] No existing subscription found for user: ${userId}`);
      }
      
      if (existingSubscription?.stripe_subscription_id) {
        // Cancel the existing Stripe subscription if it exists
        log(`[${requestId}] Canceling Stripe subscription: ${existingSubscription.stripe_subscription_id}`);
        try {
          await stripe.subscriptions.cancel(existingSubscription.stripe_subscription_id);
          log(`[${requestId}] Successfully canceled Stripe subscription`);
        } catch (err) {
          log(`[${requestId}] Error canceling subscription: ${err.message}`, err);
        }
      }
      
      // Update or insert the subscription record
      const now = new Date();
      const currentPeriodStart = now.toISOString();
      const currentPeriodEnd = new Date(now.setMonth(now.getMonth() + 1)).toISOString();
      log(`[${requestId}] Setting subscription period: ${currentPeriodStart} to ${currentPeriodEnd}`);
      
      if (existingSubscription) {
        // Update existing subscription
        log(`[${requestId}] Updating existing subscription record: ${existingSubscription.id}`);
        const updateData = {
          tier_id: tierData.id,
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          status: 'active',
          stripe_subscription_id: null,
        };
        log(`[${requestId}] Update data:`, updateData);
        
        const { error } = await supabaseClient
          .from('user_subscriptions')
          .update(updateData)
          .eq('id', existingSubscription.id);
          
        if (error) {
          log(`[${requestId}] Error updating subscription: ${error.message}`, error);
          throw error;
        }
        log(`[${requestId}] Subscription updated successfully`);
      } else {
        // Create new subscription
        log(`[${requestId}] Creating new subscription record for user: ${userId}`);
        const insertData = {
          user_id: userId,
          tier_id: tierData.id,
          current_period_start: currentPeriodStart,
          current_period_end: currentPeriodEnd,
          status: 'active',
        };
        log(`[${requestId}] Insert data:`, insertData);
        
        const { error } = await supabaseClient
          .from('user_subscriptions')
          .insert(insertData);
          
        if (error) {
          log(`[${requestId}] Error creating subscription: ${error.message}`, error);
          throw error;
        }
        log(`[${requestId}] Subscription created successfully`);
      }
      
      // Return success response
      const redirectUrl = `${appUrl}/subscription?success=true`;
      log(`[${requestId}] Returning free tier success response with redirect URL: ${redirectUrl}`);
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'Downgraded to free plan',
          redirectUrl: redirectUrl
        }),
        { 
          status: 200,
          headers: { 
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        }
      );
    } else {
      // For paid tiers, create a payment link
      log(`[${requestId}] Processing paid tier subscription: ${tierName}`);
      
      // Get user email and Stripe customer ID
      log(`[${requestId}] Fetching user data for: ${userId}`);
      const { data: userData, error: userError } = await supabaseClient
        .auth.admin.getUserById(userId);
        
      if (userError) {
        log(`[${requestId}] Error fetching user data: ${userError.message}`, userError);
        throw userError;
      }
      
      log(`[${requestId}] Found user data`, { email: userData.user.email });
      
      // Look up the user's Stripe customer ID
      log(`[${requestId}] Looking up Stripe customer ID for user: ${userId}`);
      const { data: subscriptionData, error: subscriptionError } = await supabaseClient
        .from('user_subscriptions')
        .select('stripe_customer_id')
        .eq('user_id', userId)
        .single();
      
      if (subscriptionError) {
        log(`[${requestId}] Error fetching subscription data: ${subscriptionError.message}`, subscriptionError);
        throw subscriptionError;
      }
      
      let stripeCustomerId = subscriptionData?.stripe_customer_id;
      
      // If no Stripe customer ID exists, create one
      if (!stripeCustomerId) {
        log(`[${requestId}] No Stripe customer ID found, creating one`);
        
        try {
          // Create customer in Stripe
          const customer = await stripe.customers.create({
            email: userData.user.email,
            metadata: {
              user_id: userId
            }
          });
          
          stripeCustomerId = customer.id;
          log(`[${requestId}] Stripe customer created: ${stripeCustomerId}`);
          
          // Update the subscription record with the customer ID
          const { error: updateError } = await supabaseClient
            .from('user_subscriptions')
            .update({ stripe_customer_id: stripeCustomerId })
            .eq('user_id', userId);
            
          if (updateError) {
            log(`[${requestId}] Error updating user_subscriptions with Stripe customer ID: ${updateError.message}`, updateError);
            // Continue anyway, don't throw
          } else {
            log(`[${requestId}] Updated user_subscriptions with Stripe customer ID`);
          }
        } catch (err) {
          log(`[${requestId}] Error creating Stripe customer: ${err.message}`, err);
          // Continue without a customer ID, will create one during checkout
        }
      } else {
        log(`[${requestId}] Found existing Stripe customer ID: ${stripeCustomerId}`);
      }
      
      // Create payment link parameters
      const createPaymentLinkParams = {
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        after_completion: {
          type: 'redirect',
          redirect: {
            url: `${appUrl}/subscription?success=true`,
          },
        }
      };
      
      // If we have a customer ID, use it
      if (stripeCustomerId) {
        createPaymentLinkParams.customer = stripeCustomerId;
      }
      
      log(`[${requestId}] Payment link parameters:`, createPaymentLinkParams);
      
      try {
        const paymentLink = await stripe.paymentLinks.create(createPaymentLinkParams);
        log(`[${requestId}] Payment link created successfully`, { 
          url: paymentLink.url,
          id: paymentLink.id 
        });
        
        // Return the URL of the payment link
        return new Response(
          JSON.stringify({ url: paymentLink.url }),
          { 
            status: 200,
            headers: { 
              ...corsHeaders,
              'Content-Type': 'application/json'
            }
          }
        );
      } catch (stripeError) {
        log(`[${requestId}] Stripe error creating payment link: ${stripeError.message}`, {
          type: stripeError.type,
          code: stripeError.code,
          param: stripeError.param,
          detail: stripeError
        });
        throw stripeError;
      }
    }
  } catch (error) {
    const errorMessage = error.message || 'Unknown error';
    log(`[${requestId}] Error processing request: ${errorMessage}`, {
      stack: error.stack,
      error: error
    });
    
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { 
        status: 500,
        headers: { 
          ...corsHeaders,
          'Content-Type': 'application/json'
        }
      }
    );
  }
}); 