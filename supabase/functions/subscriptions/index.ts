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

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { action } = await req.json();
    const authHeader = req.headers.get('Authorization');
    
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !user) {
      throw new Error('Invalid token');
    }

    switch (action) {
      case 'create_checkout_session': {
        const { priceId } = await req.json();
        const session = await stripe.checkout.sessions.create({
          customer_email: user.email,
          line_items: [{ price: priceId, quantity: 1 }],
          mode: 'subscription',
          success_url: `${Deno.env.get('CLIENT_URL')}/settings?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${Deno.env.get('CLIENT_URL')}/settings`,
          metadata: {
            user_id: user.id,
          },
        });

        return new Response(
          JSON.stringify({ url: session.url }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'get_subscription': {
        const { data: subscription, error: subError } = await supabase
          .from('user_subscriptions')
          .select('*, subscription_tiers(*)')
          .eq('user_id', user.id)
          .single();

        if (subError) {
          throw subError;
        }

        return new Response(
          JSON.stringify({ subscription }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      case 'get_usage': {
        const now = new Date();
        const { data: usage, error: usageError } = await supabase
          .from('usage_tracking')
          .select('*')
          .eq('user_id', user.id)
          .lte('period_start', now.toISOString())
          .gte('period_end', now.toISOString())
          .single();

        if (usageError) {
          throw usageError;
        }

        return new Response(
          JSON.stringify({ usage }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      default:
        throw new Error('Invalid action');
    }
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { 
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
}); 