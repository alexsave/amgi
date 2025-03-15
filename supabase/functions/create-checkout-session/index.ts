import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@12.6.0?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') as string, {
  apiVersion: '2023-10-16',
});

const supabaseClient = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
      status: 204,
    });
  }

  try {
    const { priceId, customerId, userId, tierName } = await req.json();

    if (!userId || !priceId) {
      return new Response(
        JSON.stringify({ error: 'Missing required parameters' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Get the tier data
    const { data: tierData, error: tierError } = await supabaseClient
      .from('subscription_tiers')
      .select('*')
      .eq('stripe_price_id', priceId)
      .single();
      
    if (tierError) {
      return new Response(
        JSON.stringify({ error: 'Invalid price ID' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let session;
    
    // Get the app URL from environment variable for success/cancel URLs
    const appUrl = Deno.env.get('APP_URL') || 'http://localhost:3000';
    
    if (tierName === 'Free') {
      // For free tier, don't create a Stripe subscription
      // Instead update the user_subscriptions table directly
      
      // First check if user has an existing subscription
      const { data: existingSubscription, error: subError } = await supabaseClient
        .from('user_subscriptions')
        .select('*')
        .eq('user_id', userId)
        .single();
        
      if (subError && subError.code !== 'PGRST116') {
        throw subError;
      }
      
      if (existingSubscription?.stripe_subscription_id) {
        // Cancel the existing Stripe subscription if it exists
        try {
          await stripe.subscriptions.cancel(existingSubscription.stripe_subscription_id);
        } catch (err) {
          console.error('Error canceling subscription:', err);
        }
      }
      
      // Update or insert the subscription record
      const now = new Date();
      const currentPeriodStart = now.toISOString();
      const currentPeriodEnd = new Date(now.setMonth(now.getMonth() + 1)).toISOString();
      
      if (existingSubscription) {
        // Update existing subscription
        const { error } = await supabaseClient
          .from('user_subscriptions')
          .update({
            tier_id: tierData.id,
            current_period_start: currentPeriodStart,
            current_period_end: currentPeriodEnd,
            status: 'active',
            stripe_subscription_id: null,
          })
          .eq('id', existingSubscription.id);
          
        if (error) throw error;
      } else {
        // Create new subscription
        const { error } = await supabaseClient
          .from('user_subscriptions')
          .insert({
            user_id: userId,
            tier_id: tierData.id,
            current_period_start: currentPeriodStart,
            current_period_end: currentPeriodEnd,
            status: 'active',
          });
          
        if (error) throw error;
      }
      
      // Return success response
      return new Response(
        JSON.stringify({ 
          success: true,
          message: 'Downgraded to free plan',
          redirectUrl: `${appUrl}/subscription?success=true`
        }),
        { 
          status: 200,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        }
      );
    } else {
      // For paid tiers, create or update a Stripe subscription
      let customer = customerId;
      
      // If no customer ID exists, get user email and create a customer
      if (!customer) {
        const { data: userData, error: userError } = await supabaseClient
          .auth.admin.getUserById(userId);
          
        if (userError) throw userError;
        
        const { id: newCustomerId } = await stripe.customers.create({
          email: userData.user.email,
          metadata: {
            user_id: userId
          }
        });
        
        customer = newCustomerId;
        
        // Update customer_id in our database
        const { data: existingSub, error: subError } = await supabaseClient
          .from('user_subscriptions')
          .select('*')
          .eq('user_id', userId)
          .single();
          
        if (!subError) {
          await supabaseClient
            .from('user_subscriptions')
            .update({ stripe_customer_id: customer })
            .eq('id', existingSub.id);
        }
      }
      
      // Create a checkout session
      session = await stripe.checkout.sessions.create({
        customer: customer,
        line_items: [
          {
            price: priceId,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${appUrl}/subscription?success=true`,
        cancel_url: `${appUrl}/subscription?canceled=true`,
        metadata: {
          user_id: userId,
          tier_id: tierData.id
        }
      });
    }

    return new Response(
      JSON.stringify({ sessionId: session.id }),
      { 
        status: 200,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      }
    );
  }
}); 