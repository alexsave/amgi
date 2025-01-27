#!/bin/bash

# Deploy all functions
echo "Deploying speech function..."
supabase functions deploy speech --project-ref ydzjzarpeogazkxtoxtw

echo "Deploying cards function..."
supabase functions deploy cards --project-ref ydzjzarpeogazkxtoxtw

echo "Deploying realtime function..."
supabase functions deploy realtime --project-ref ydzjzarpeogazkxtoxtw

echo "All functions deployed!" 