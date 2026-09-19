


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."check_and_increment_usage"("p_user_id" "uuid", "p_field" "text", "p_amount" integer, "p_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  v_usage usage_tracking%rowtype;
begin
  if p_field not in (
    'realtime_sessions_started',
    'voice_evaluations_used',
    'card_audio_generations_used'
  ) then
    raise exception 'unknown usage field: %', p_field;
  end if;

  -- Guarded atomic increment: only applies when unlimited, within limit,
  -- or refunding (negative amount, floored at zero).
  execute format(
    'update usage_tracking
        set %1$I = greatest(0, %1$I + $1)
      where user_id = $2
        and ($1 < 0 or $3 = -1 or %1$I + $1 <= $3)
      returning *',
    p_field
  )
  into v_usage
  using p_amount, p_user_id, p_limit;

  if v_usage.id is not null then
    return jsonb_build_object('allowed', true, 'usage', to_jsonb(v_usage));
  end if;

  -- Increment was blocked (or no row matched) — report current usage.
  select * into v_usage from usage_tracking where user_id = p_user_id;
  if not found then
    raise exception 'no usage_tracking row for user %', p_user_id;
  end if;

  return jsonb_build_object('allowed', false, 'usage', to_jsonb(v_usage));
end;
$_$;


ALTER FUNCTION "public"."check_and_increment_usage"("p_user_id" "uuid", "p_field" "text", "p_amount" integer, "p_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_cards_returning_orphaned_audio"("p_user_id" "uuid", "p_card_ids" "uuid"[]) RETURNS SETOF "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_candidates text[];
begin
  select array_agg(distinct v.path) into v_candidates
  from public.cards c
  join public.decks d on d.id = c.deck_id
  cross join lateral (values (c.front_audio_path), (c.back_audio_path)) as v(path)
  where c.id = any(p_card_ids)
    and d.user_id = p_user_id
    and v.path is not null;

  delete from public.cards c
  using public.decks d
  where d.id = c.deck_id
    and c.id = any(p_card_ids)
    and d.user_id = p_user_id;

  return query
  select path
  from unnest(coalesce(v_candidates, array[]::text[])) as path
  where not exists (
    select 1 from public.cards c2
    where c2.front_audio_path = path
       or c2.back_audio_path = path
  );
end;
$$;


ALTER FUNCTION "public"."delete_cards_returning_orphaned_audio"("p_user_id" "uuid", "p_card_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."delete_deck_returning_orphaned_audio"("p_user_id" "uuid", "p_deck_id" "uuid") RETURNS SETOF "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  v_candidates text[];
begin
  select array_agg(distinct v.path) into v_candidates
  from public.cards c
  join public.decks d on d.id = c.deck_id
  cross join lateral (values (c.front_audio_path), (c.back_audio_path)) as v(path)
  where c.deck_id = p_deck_id
    and d.user_id = p_user_id
    and v.path is not null;

  delete from public.decks
  where id = p_deck_id
    and user_id = p_user_id;

  return query
  select path
  from unnest(coalesce(v_candidates, array[]::text[])) as path
  where not exists (
    select 1 from public.cards c2
    where c2.front_audio_path = path
       or c2.back_audio_path = path
  );
end;
$$;


ALTER FUNCTION "public"."delete_deck_returning_orphaned_audio"("p_user_id" "uuid", "p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  free_tier_id uuid;
  now_time timestamp;
  end_time timestamp;
begin
  -- Get the ID of the free tier
  select id into free_tier_id from public.subscription_tiers where name = 'Free';
  
  -- Set subscription period using timestamps
  now_time := now();
  end_time := now_time + interval '1 month';
  
  -- Create user_subscription record with free tier
  insert into public.user_subscriptions (
    user_id, 
    tier_id, 
    current_period_start, 
    current_period_end, 
    status
  )
  values (
    new.id, 
    free_tier_id, 
    now_time, 
    end_time, 
    'active'
  );
  
  -- Create initial usage_tracking record with zeroed usage
  insert into public.usage_tracking (
    user_id,
    realtime_sessions_started,
    voice_evaluations_used,
    card_audio_generations_used
  )
  values (
    new.id,
    0,
    0,
    0
  );
  
  -- Return the newly created user
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."cards" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "deck_id" "uuid" NOT NULL,
    "position" integer NOT NULL,
    "front_text" "text" NOT NULL,
    "back_text" "text" NOT NULL,
    "front_audio_path" "text",
    "back_audio_path" "text",
    "front_lang" "text" NOT NULL,
    "back_lang" "text" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."decks" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "known_language" "text" DEFAULT 'en'::"text" NOT NULL,
    "learning_language" "text" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."decks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."review_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "card_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "reviewed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "rating" "text" NOT NULL,
    "card_state" "text" NOT NULL,
    "interval_days" integer NOT NULL,
    "ease_factor" real NOT NULL,
    "repetitions" integer NOT NULL,
    "elapsed_days" integer,
    "scheduled_days" integer,
    CONSTRAINT "review_logs_card_state_check" CHECK (("card_state" = ANY (ARRAY['new'::"text", 'learning'::"text", 'review'::"text"]))),
    CONSTRAINT "review_logs_rating_check" CHECK (("rating" = ANY (ARRAY['again'::"text", 'hard'::"text", 'good'::"text", 'easy'::"text"])))
);


ALTER TABLE "public"."review_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reviews" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "card_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "scheduled_date" "date" NOT NULL,
    "interval_days" integer DEFAULT 1,
    "ease_factor" double precision DEFAULT 2.5,
    "repetitions" integer DEFAULT 0,
    "last_reviewed_at" timestamp with time zone,
    "next_review_date" timestamp with time zone,
    "card_state" "text" DEFAULT 'new'::"text" NOT NULL,
    "learning_step" integer DEFAULT 0 NOT NULL,
    "lapses" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "reviews_card_state_check" CHECK (("card_state" = ANY (ARRAY['new'::"text", 'learning'::"text", 'review'::"text"])))
);


ALTER TABLE "public"."reviews" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_tiers" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "name" "text" NOT NULL,
    "realtime_sessions_limit" integer NOT NULL,
    "voice_evaluations_limit" integer NOT NULL,
    "card_audio_generations_limit" integer NOT NULL,
    "stripe_price_id" "text" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."subscription_tiers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."usage_tracking" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "realtime_sessions_started" integer DEFAULT 0,
    "voice_evaluations_used" integer DEFAULT 0,
    "card_audio_generations_used" integer DEFAULT 0,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."usage_tracking" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_preferences" (
    "user_id" "uuid" NOT NULL,
    "daily_goal" integer DEFAULT 50 NOT NULL,
    "preferred_language" "text" DEFAULT 'en'::"text" NOT NULL,
    "notifications_enabled" boolean DEFAULT true NOT NULL,
    "dark_mode" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."user_preferences" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_subscriptions" (
    "id" "uuid" DEFAULT "extensions"."uuid_generate_v4"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "tier_id" "uuid" NOT NULL,
    "stripe_subscription_id" "text",
    "stripe_customer_id" "text",
    "current_period_start" timestamp without time zone NOT NULL,
    "current_period_end" timestamp without time zone NOT NULL,
    "status" "text" NOT NULL,
    "created_at" timestamp without time zone DEFAULT "now"(),
    "updated_at" timestamp without time zone DEFAULT "now"()
);


ALTER TABLE "public"."user_subscriptions" OWNER TO "postgres";


ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_deck_id_position_key" UNIQUE ("deck_id", "position");



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."review_logs"
    ADD CONSTRAINT "review_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_card_id_user_id_key" UNIQUE ("card_id", "user_id");



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_tiers"
    ADD CONSTRAINT "subscription_tiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."usage_tracking"
    ADD CONSTRAINT "usage_tracking_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."usage_tracking"
    ADD CONSTRAINT "usage_tracking_user_id_key" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."user_subscriptions"
    ADD CONSTRAINT "user_subscriptions_pkey" PRIMARY KEY ("id");



CREATE INDEX "cards_back_audio_path_idx" ON "public"."cards" USING "btree" ("back_audio_path") WHERE ("back_audio_path" IS NOT NULL);



CREATE INDEX "cards_deck_id_idx" ON "public"."cards" USING "btree" ("deck_id");



CREATE INDEX "cards_front_audio_path_idx" ON "public"."cards" USING "btree" ("front_audio_path") WHERE ("front_audio_path" IS NOT NULL);



CREATE INDEX "cards_position_idx" ON "public"."cards" USING "btree" ("deck_id", "position");



CREATE INDEX "review_logs_card_reviewed_idx" ON "public"."review_logs" USING "btree" ("card_id", "reviewed_at");



CREATE INDEX "review_logs_user_reviewed_idx" ON "public"."review_logs" USING "btree" ("user_id", "reviewed_at");



CREATE INDEX "reviews_card_id_idx" ON "public"."reviews" USING "btree" ("card_id");



CREATE INDEX "reviews_next_review_date_idx" ON "public"."reviews" USING "btree" ("next_review_date");



CREATE INDEX "reviews_user_id_idx" ON "public"."reviews" USING "btree" ("user_id");



CREATE INDEX "usage_tracking_user_id_idx" ON "public"."usage_tracking" USING "btree" ("user_id");



CREATE INDEX "user_subscriptions_user_id_idx" ON "public"."user_subscriptions" USING "btree" ("user_id");



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_logs"
    ADD CONSTRAINT "review_logs_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."review_logs"
    ADD CONSTRAINT "review_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reviews"
    ADD CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."usage_tracking"
    ADD CONSTRAINT "usage_tracking_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_preferences"
    ADD CONSTRAINT "user_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_subscriptions"
    ADD CONSTRAINT "user_subscriptions_tier_id_fkey" FOREIGN KEY ("tier_id") REFERENCES "public"."subscription_tiers"("id");



ALTER TABLE ONLY "public"."user_subscriptions"
    ADD CONSTRAINT "user_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "Anyone can view subscription tiers" ON "public"."subscription_tiers" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Users can delete cards in their decks" ON "public"."cards" FOR DELETE USING ((EXISTS ( SELECT 1
   FROM "public"."decks"
  WHERE (("decks"."id" = "cards"."deck_id") AND ("decks"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can delete their own decks" ON "public"."decks" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can delete their own reviews" ON "public"."reviews" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert cards in their decks" ON "public"."cards" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."decks"
  WHERE (("decks"."id" = "cards"."deck_id") AND ("decks"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can insert their own decks" ON "public"."decks" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own preferences" ON "public"."user_preferences" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own review logs" ON "public"."review_logs" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can insert their own reviews" ON "public"."reviews" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update cards in their decks" ON "public"."cards" FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM "public"."decks"
  WHERE (("decks"."id" = "cards"."deck_id") AND ("decks"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can update their own decks" ON "public"."decks" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own preferences" ON "public"."user_preferences" FOR UPDATE USING (("auth"."uid"() = "user_id")) WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can update their own reviews" ON "public"."reviews" FOR UPDATE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view cards in their decks" ON "public"."cards" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."decks"
  WHERE (("decks"."id" = "cards"."deck_id") AND ("decks"."user_id" = "auth"."uid"())))));



CREATE POLICY "Users can view their own decks" ON "public"."decks" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own preferences" ON "public"."user_preferences" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own review logs" ON "public"."review_logs" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own reviews" ON "public"."reviews" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own subscription" ON "public"."user_subscriptions" FOR SELECT USING (("auth"."uid"() = "user_id"));



CREATE POLICY "Users can view their own usage" ON "public"."usage_tracking" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."decks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."review_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reviews" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_tiers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."usage_tracking" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_preferences" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_subscriptions" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."check_and_increment_usage"("p_user_id" "uuid", "p_field" "text", "p_amount" integer, "p_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."check_and_increment_usage"("p_user_id" "uuid", "p_field" "text", "p_amount" integer, "p_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_cards_returning_orphaned_audio"("p_user_id" "uuid", "p_card_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_cards_returning_orphaned_audio"("p_user_id" "uuid", "p_card_ids" "uuid"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."delete_deck_returning_orphaned_audio"("p_user_id" "uuid", "p_deck_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."delete_deck_returning_orphaned_audio"("p_user_id" "uuid", "p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";


















GRANT ALL ON TABLE "public"."cards" TO "anon";
GRANT ALL ON TABLE "public"."cards" TO "authenticated";
GRANT ALL ON TABLE "public"."cards" TO "service_role";



GRANT ALL ON TABLE "public"."decks" TO "anon";
GRANT ALL ON TABLE "public"."decks" TO "authenticated";
GRANT ALL ON TABLE "public"."decks" TO "service_role";



GRANT ALL ON TABLE "public"."review_logs" TO "anon";
GRANT ALL ON TABLE "public"."review_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."review_logs" TO "service_role";



GRANT ALL ON TABLE "public"."reviews" TO "anon";
GRANT ALL ON TABLE "public"."reviews" TO "authenticated";
GRANT ALL ON TABLE "public"."reviews" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_tiers" TO "anon";
GRANT ALL ON TABLE "public"."subscription_tiers" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_tiers" TO "service_role";



GRANT ALL ON TABLE "public"."usage_tracking" TO "anon";
GRANT ALL ON TABLE "public"."usage_tracking" TO "authenticated";
GRANT ALL ON TABLE "public"."usage_tracking" TO "service_role";



GRANT ALL ON TABLE "public"."user_preferences" TO "anon";
GRANT ALL ON TABLE "public"."user_preferences" TO "authenticated";
GRANT ALL ON TABLE "public"."user_preferences" TO "service_role";



GRANT ALL ON TABLE "public"."user_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."user_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."user_subscriptions" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































