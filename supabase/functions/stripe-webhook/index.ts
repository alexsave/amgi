import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from '@supabase/supabase-js'
import Stripe from 'stripe';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2023-10-16',
});

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') || '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
);

serve(async (req) => {
  const signature = req.headers.get('stripe-signature');
  
  if (!signature) {
    return new Response('No signature', { status: 400 });
  }

  try {
    const body = await req.text();
    const event = stripe.webhooks.constructEvent(
      body,
      signature,
      Deno.env.get('STRIPE_WEBHOOK_SECRET') || ''
    );

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { user_id } = session.metadata;
        const subscription = await stripe.subscriptions.retrieve(session.subscription);
        
        // Get the price ID from the subscription
        const priceId = subscription.items.data[0].price.id;
        
        // Get the subscription tier for this price
        const { data: tier } = await supabase
          .from('subscription_tiers')
          .select('id')
          .eq('stripe_price_id', priceId)
          .single();

        if (!tier) {
          throw new Error('No matching tier found');
        }

        // Create or update user subscription
        const { error: subError } = await supabase
          .from('user_subscriptions')
          .upsert({
            user_id,
            tier_id: tier.id,
            stripe_subscription_id: subscription.id,
            stripe_customer_id: session.customer,
            current_period_start: new Date(subscription.current_period_start * 1000),
            current_period_end: new Date(subscription.current_period_end * 1000),
            status: subscription.status,
          });

        if (subError) {
          throw subError;
        }

        // Initialize usage tracking for the period
        const { error: usageError } = await supabase
          .from('usage_tracking')
          .upsert({
            user_id,
            realtime_minutes_used: 0,
            voice_evaluations_used: 0,
            period_start: new Date(subscription.current_period_start * 1000),
            period_end: new Date(subscription.current_period_end * 1000),
          });

        if (usageError) {
          throw usageError;
        }

        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        
        const { error } = await supabase
          .from('user_subscriptions')
          .update({
            current_period_start: new Date(subscription.current_period_start * 1000),
            current_period_end: new Date(subscription.current_period_end * 1000),
            status: subscription.status,
          })
          .eq('stripe_subscription_id', subscription.id);

        if (error) {
          throw error;
        }

        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        
        // Move user to free tier
        const { data: freeTier } = await supabase
          .from('subscription_tiers')
          .select('id')
          .eq('name', 'Free')
          .single();

        if (!freeTier) {
          throw new Error('Free tier not found');
        }

        const { error } = await supabase
          .from('user_subscriptions')
          .update({
            tier_id: freeTier.id,
            status: 'canceled',
          })
          .eq('stripe_subscription_id', subscription.id);

        if (error) {
          throw error;
        }

        break;
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 400 }
    );
  }
}); 