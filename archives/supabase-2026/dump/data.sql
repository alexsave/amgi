SET session_replication_role = replica;

--
-- PostgreSQL database dump
--

-- \restrict WjNF07t7UxBHY5L3LPsccrVafIMtSGLtCPNyqGjGSGR1i1iqrlQWDZODnyRV0Cp

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: audit_log_entries; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: custom_oauth_providers; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: flow_state; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

INSERT INTO "auth"."users" ("instance_id", "id", "aud", "role", "email", "encrypted_password", "email_confirmed_at", "invited_at", "confirmation_token", "confirmation_sent_at", "recovery_token", "recovery_sent_at", "email_change_token_new", "email_change", "email_change_sent_at", "last_sign_in_at", "raw_app_meta_data", "raw_user_meta_data", "is_super_admin", "created_at", "updated_at", "phone", "phone_confirmed_at", "phone_change", "phone_change_token", "phone_change_sent_at", "email_change_token_current", "email_change_confirm_status", "banned_until", "reauthentication_token", "reauthentication_sent_at", "is_sso_user", "deleted_at", "is_anonymous") VALUES
	('00000000-0000-0000-0000-000000000000', 'f17ac20c-5e23-4e4f-86cb-fd48374ca0a7', 'authenticated', 'authenticated', 'amgi-e2e-1789755037@mailinator.com', '$2a$10$cKDOHy.TQEgnTlAIs92FmecMlThrawGF7u/bQUquiYTm3LiQAPlHu', NULL, NULL, '4e95e226c1d90dc9e8a2ec97524fdf21578443889e54af4092ec7468', '2026-09-18 18:10:41.54176+00', '', NULL, '', '', NULL, NULL, '{"provider": "email", "providers": ["email"]}', '{"sub": "f17ac20c-5e23-4e4f-86cb-fd48374ca0a7", "email": "amgi-e2e-1789755037@mailinator.com", "isAdult": true, "email_verified": false, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', NULL, '2026-09-18 18:10:41.481061+00', '2026-09-18 18:10:42.744107+00', NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL, false, NULL, false),
	('00000000-0000-0000-0000-000000000000', '7abea1d0-ad2c-4333-8a66-162a510db296', 'authenticated', 'authenticated', 'amgi-e2e-1789755059@mailinator.com', '$2a$10$9cyBXm4.iJ920d91.labDONySFckH8HUTmSQHreucG..W.AjzpZSy', NULL, NULL, '87af5bf1a1d94ce911fae26806fdacb6d70289a9308d27155df2dd28', '2026-09-18 18:11:03.304537+00', '', NULL, '', '', NULL, NULL, '{"provider": "email", "providers": ["email"]}', '{"sub": "7abea1d0-ad2c-4333-8a66-162a510db296", "email": "amgi-e2e-1789755059@mailinator.com", "isAdult": true, "email_verified": false, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', NULL, '2026-09-18 18:11:03.296616+00', '2026-09-18 18:11:04.417795+00', NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL, false, NULL, false),
	('00000000-0000-0000-0000-000000000000', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', 'authenticated', 'authenticated', 'linhsil2311@gmail.com', '$2a$10$a9Vgh0bJHxwq8kvpAHZshukIjRmOVibhlk2p2kxP1HH3d9NQg4Hgu', '2026-07-05 01:44:43.899926+00', NULL, '', '2026-07-05 01:44:28.331271+00', '', '2026-07-05 01:46:23.925829+00', '', '', NULL, '2026-07-05 01:46:34.991751+00', '{"provider": "email", "providers": ["email"]}', '{"sub": "fd94820f-6c1a-4e0b-a175-f376c7dce351", "email": "linhsil2311@gmail.com", "isAdult": true, "email_verified": true, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', NULL, '2026-07-05 01:44:28.22419+00', '2026-07-09 08:21:32.972745+00', NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL, false, NULL, false),
	('00000000-0000-0000-0000-000000000000', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', 'authenticated', 'authenticated', 'test@amgi.cards', '$2a$10$vSq31ErLRBv7qi3lx5hrHOJUSzJf1/oBmJbVulsVwgGy/0BKpSHvS', '2026-09-18 19:30:15.876678+00', NULL, '', NULL, '', NULL, '', '', NULL, '2026-09-18 23:40:49.655233+00', '{"provider": "email", "providers": ["email"]}', '{"email_verified": true}', NULL, '2026-09-18 19:30:15.805634+00', '2026-09-18 23:40:49.715752+00', NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL, false, NULL, false),
	('00000000-0000-0000-0000-000000000000', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'authenticated', 'authenticated', 'alexvsaveliev@gmail.com', '$2a$10$0KzQ/hXbLcovJGFy4IT2LuvTVVIbQJKYg0w3NO5EXjl1RX.ArOMGO', '2026-07-04 14:06:51.80016+00', NULL, '', '2026-07-04 14:06:21.140076+00', '', NULL, '', '', NULL, '2026-09-18 17:59:49.941503+00', '{"provider": "email", "providers": ["email"]}', '{"sub": "dc1aac9b-8cac-4e30-acdf-ddfaceb49b72", "email": "alexvsaveliev@gmail.com", "isAdult": true, "email_verified": true, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', NULL, '2026-07-04 14:06:21.079609+00', '2026-09-19 01:05:42.114251+00', NULL, NULL, '', '', NULL, '', 0, NULL, '', NULL, false, NULL, false);


--
-- Data for Name: identities; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

INSERT INTO "auth"."identities" ("provider_id", "user_id", "identity_data", "provider", "last_sign_in_at", "created_at", "updated_at", "id") VALUES
	('dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '{"sub": "dc1aac9b-8cac-4e30-acdf-ddfaceb49b72", "email": "alexvsaveliev@gmail.com", "isAdult": true, "email_verified": true, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', 'email', '2026-07-04 14:06:21.129804+00', '2026-07-04 14:06:21.129852+00', '2026-07-04 14:06:21.129852+00', '68091857-b12f-451e-899a-29b061a454f4'),
	('fd94820f-6c1a-4e0b-a175-f376c7dce351', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', '{"sub": "fd94820f-6c1a-4e0b-a175-f376c7dce351", "email": "linhsil2311@gmail.com", "isAdult": true, "email_verified": true, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', 'email', '2026-07-05 01:44:28.315926+00', '2026-07-05 01:44:28.31598+00', '2026-07-05 01:44:28.31598+00', '06f038b7-96b9-4300-9cdc-6da8f5d19561'),
	('f17ac20c-5e23-4e4f-86cb-fd48374ca0a7', 'f17ac20c-5e23-4e4f-86cb-fd48374ca0a7', '{"sub": "f17ac20c-5e23-4e4f-86cb-fd48374ca0a7", "email": "amgi-e2e-1789755037@mailinator.com", "isAdult": true, "email_verified": false, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', 'email', '2026-09-18 18:10:41.526932+00', '2026-09-18 18:10:41.527039+00', '2026-09-18 18:10:41.527039+00', 'de1bc965-2974-4cb9-a4cb-db5e36504393'),
	('7abea1d0-ad2c-4333-8a66-162a510db296', '7abea1d0-ad2c-4333-8a66-162a510db296', '{"sub": "7abea1d0-ad2c-4333-8a66-162a510db296", "email": "amgi-e2e-1789755059@mailinator.com", "isAdult": true, "email_verified": false, "phone_verified": false, "hasAcceptedEULA": true, "hasAcceptedPrivacy": true}', 'email', '2026-09-18 18:11:03.3012+00', '2026-09-18 18:11:03.301256+00', '2026-09-18 18:11:03.301256+00', '3d1c400a-eb4f-40d4-8fef-f9159dd6d91d'),
	('c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{"sub": "c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3", "email": "test@amgi.cards", "email_verified": false, "phone_verified": false}', 'email', '2026-09-18 19:30:15.868155+00', '2026-09-18 19:30:15.868252+00', '2026-09-18 19:30:15.868252+00', 'dd85b52e-6e97-444e-90d4-368645e2ae08');


--
-- Data for Name: instances; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: oauth_clients; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: sessions; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

INSERT INTO "auth"."sessions" ("id", "user_id", "created_at", "updated_at", "factor_id", "aal", "not_after", "refreshed_at", "user_agent", "ip", "tag", "oauth_client_id", "refresh_token_hmac_key", "refresh_token_counter", "scopes") VALUES
	('684245d5-ddb4-4b96-a6e9-8601ecc94b3c', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-04 14:06:51.80581+00', '2026-07-05 00:16:36.557033+00', NULL, 'aal1', NULL, '2026-07-05 00:16:36.556923', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15', '221.162.46.155', NULL, NULL, NULL, NULL, NULL),
	('caac3a30-31d2-4202-a413-f39fe4100bf8', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-05 00:54:02.890089+00', '2026-07-05 00:54:02.890089+00', NULL, 'aal1', NULL, NULL, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Safari/605.1.15', '221.162.46.155', NULL, NULL, NULL, NULL, NULL),
	('fc2bb1e6-b5bc-455a-a463-c407af31aeaf', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', '2026-07-05 01:44:43.908015+00', '2026-07-05 01:44:43.908015+00', NULL, 'aal1', NULL, NULL, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', '221.162.46.155', NULL, NULL, NULL, NULL, NULL),
	('8ae7b520-092c-4653-acb7-8727192d57d0', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', '2026-07-05 01:46:34.994331+00', '2026-07-09 08:21:32.988002+00', NULL, 'aal1', NULL, '2026-07-09 08:21:32.987892', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1', '210.245.34.140', NULL, NULL, NULL, NULL, NULL),
	('f67dcb98-05aa-420f-9611-36f2792f1069', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-05 00:56:21.664367+00', '2026-07-22 20:01:24.432543+00', NULL, 'aal1', NULL, '2026-07-22 20:01:24.432414', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5.2 Safari/605.1.15', '157.25.81.68', NULL, NULL, NULL, NULL, NULL),
	('872c387a-6e3d-4eb2-ba29-c8eddaaeecc8', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:16.589614+00', '2026-09-18 19:30:16.589614+00', NULL, 'aal1', NULL, NULL, 'node', '198.254.122.177', NULL, NULL, NULL, NULL, NULL),
	('757cfc51-250b-4c31-9de4-304b0d7d34fb', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:31:04.410627+00', '2026-09-18 19:31:04.410627+00', NULL, 'aal1', NULL, NULL, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36', '198.254.122.177', NULL, NULL, NULL, NULL, NULL),
	('c2133b7c-c5b2-46bf-ac15-9d3475eb8b14', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:31:23.282008+00', '2026-09-18 19:31:23.282008+00', NULL, 'aal1', NULL, NULL, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36', '198.254.122.177', NULL, NULL, NULL, NULL, NULL),
	('4a5d669a-4d95-4411-9e0c-b2640ff85023', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 20:05:51.094544+00', '2026-09-18 20:05:51.094544+00', NULL, 'aal1', NULL, NULL, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36', '198.254.122.177', NULL, NULL, NULL, NULL, NULL),
	('172b89bd-d693-4a51-afde-2869318a0b9e', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 23:40:49.656388+00', '2026-09-18 23:40:49.656388+00', NULL, 'aal1', NULL, NULL, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36', '198.254.122.177', NULL, NULL, NULL, NULL, NULL),
	('c20d82eb-af0c-4dea-aeca-9a73db2987d1', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18 17:59:49.942221+00', '2026-09-19 01:05:42.132367+00', NULL, 'aal1', NULL, '2026-09-19 01:05:42.132224', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15', '198.254.122.177', NULL, NULL, NULL, NULL, NULL);


--
-- Data for Name: mfa_amr_claims; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

INSERT INTO "auth"."mfa_amr_claims" ("session_id", "created_at", "updated_at", "authentication_method", "id") VALUES
	('684245d5-ddb4-4b96-a6e9-8601ecc94b3c', '2026-07-04 14:06:51.817953+00', '2026-07-04 14:06:51.817953+00', 'otp', '570a9a47-1e65-4d67-84e2-d168f6d584ec'),
	('caac3a30-31d2-4202-a413-f39fe4100bf8', '2026-07-05 00:54:02.923106+00', '2026-07-05 00:54:02.923106+00', 'password', 'c2a97e8d-3571-4a56-8e11-d449c7a70a31'),
	('f67dcb98-05aa-420f-9611-36f2792f1069', '2026-07-05 00:56:21.683238+00', '2026-07-05 00:56:21.683238+00', 'password', 'f32c8d03-60cb-4e3f-80de-4c19b7c8aa12'),
	('fc2bb1e6-b5bc-455a-a463-c407af31aeaf', '2026-07-05 01:44:43.923254+00', '2026-07-05 01:44:43.923254+00', 'otp', 'cdf57fc7-34b5-4536-9384-1ad4fa1e5525'),
	('8ae7b520-092c-4653-acb7-8727192d57d0', '2026-07-05 01:46:34.999087+00', '2026-07-05 01:46:34.999087+00', 'otp', '053bf547-edb4-47df-9afb-0978901a73f0'),
	('c20d82eb-af0c-4dea-aeca-9a73db2987d1', '2026-09-18 17:59:50.004595+00', '2026-09-18 17:59:50.004595+00', 'password', '00889f73-a246-49ca-96b1-2687f4ea2cfc'),
	('872c387a-6e3d-4eb2-ba29-c8eddaaeecc8', '2026-09-18 19:30:16.61389+00', '2026-09-18 19:30:16.61389+00', 'password', '07f3227f-e08a-4aef-a275-d17b5a57fe71'),
	('757cfc51-250b-4c31-9de4-304b0d7d34fb', '2026-09-18 19:31:04.426624+00', '2026-09-18 19:31:04.426624+00', 'password', '6bc68410-965d-4933-b81c-2e94d7d23f07'),
	('c2133b7c-c5b2-46bf-ac15-9d3475eb8b14', '2026-09-18 19:31:23.287818+00', '2026-09-18 19:31:23.287818+00', 'password', '9816b78c-0e73-4ddc-9ef5-040c00706034'),
	('4a5d669a-4d95-4411-9e0c-b2640ff85023', '2026-09-18 20:05:51.147174+00', '2026-09-18 20:05:51.147174+00', 'password', '6c55db51-7932-4899-9d63-d4a98134d407'),
	('172b89bd-d693-4a51-afde-2869318a0b9e', '2026-09-18 23:40:49.724357+00', '2026-09-18 23:40:49.724357+00', 'password', '1b68c77f-cb1b-430e-8d4f-179cd0ba6d3e');


--
-- Data for Name: mfa_factors; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: mfa_challenges; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: mfa_recovery_code_sets; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: mfa_recovery_codes; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: oauth_authorizations; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: oauth_client_states; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: oauth_consents; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: one_time_tokens; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

INSERT INTO "auth"."one_time_tokens" ("id", "user_id", "token_type", "token_hash", "relates_to", "created_at", "updated_at", "expires_at") VALUES
	('475809cf-52cc-40c1-b0bf-048492bf68ec', 'f17ac20c-5e23-4e4f-86cb-fd48374ca0a7', 'confirmation_token', '4e95e226c1d90dc9e8a2ec97524fdf21578443889e54af4092ec7468', 'amgi-e2e-1789755037@mailinator.com', '2026-09-18 18:10:42.75195', '2026-09-18 18:10:42.75195', NULL),
	('0b290af2-2564-48d3-b806-6e04c13dd1af', '7abea1d0-ad2c-4333-8a66-162a510db296', 'confirmation_token', '87af5bf1a1d94ce911fae26806fdacb6d70289a9308d27155df2dd28', 'amgi-e2e-1789755059@mailinator.com', '2026-09-18 18:11:04.419152', '2026-09-18 18:11:04.419152', NULL);


--
-- Data for Name: refresh_tokens; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--

INSERT INTO "auth"."refresh_tokens" ("instance_id", "id", "token", "user_id", "revoked", "created_at", "updated_at", "parent", "session_id") VALUES
	('00000000-0000-0000-0000-000000000000', 1, 'c5wlotjmksxc', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-04 14:06:51.810686+00', '2026-07-04 15:38:33.481559+00', NULL, '684245d5-ddb4-4b96-a6e9-8601ecc94b3c'),
	('00000000-0000-0000-0000-000000000000', 2, 'jcdxhgptxvep', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-04 15:38:33.497714+00', '2026-07-04 16:57:29.308703+00', 'c5wlotjmksxc', '684245d5-ddb4-4b96-a6e9-8601ecc94b3c'),
	('00000000-0000-0000-0000-000000000000', 3, 'vjortxsitkmk', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-04 16:57:29.316832+00', '2026-07-04 18:19:06.22232+00', 'jcdxhgptxvep', '684245d5-ddb4-4b96-a6e9-8601ecc94b3c'),
	('00000000-0000-0000-0000-000000000000', 4, 'b5xtjdg3j5ex', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-04 18:19:06.233522+00', '2026-07-04 22:07:47.246872+00', 'vjortxsitkmk', '684245d5-ddb4-4b96-a6e9-8601ecc94b3c'),
	('00000000-0000-0000-0000-000000000000', 5, 'iegfleyojwy5', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', false, '2026-07-04 22:07:47.260808+00', '2026-07-04 22:07:47.260808+00', 'b5xtjdg3j5ex', '684245d5-ddb4-4b96-a6e9-8601ecc94b3c'),
	('00000000-0000-0000-0000-000000000000', 6, 'd6pxcsxg5tm2', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', false, '2026-07-05 00:54:02.910386+00', '2026-07-05 00:54:02.910386+00', NULL, 'caac3a30-31d2-4202-a413-f39fe4100bf8'),
	('00000000-0000-0000-0000-000000000000', 8, '3qhrwkkzkyqh', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', false, '2026-07-05 01:44:43.915819+00', '2026-07-05 01:44:43.915819+00', NULL, 'fc2bb1e6-b5bc-455a-a463-c407af31aeaf'),
	('00000000-0000-0000-0000-000000000000', 9, 'wez5hyieiwyl', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-05 01:46:34.997728+00', '2026-07-05 10:27:18.353132+00', NULL, '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 7, 'piwfuigu3wpa', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-05 00:56:21.678524+00', '2026-07-05 20:35:23.201116+00', NULL, 'f67dcb98-05aa-420f-9611-36f2792f1069'),
	('00000000-0000-0000-0000-000000000000', 10, 'hr4g62xpxdhp', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-05 10:27:18.374067+00', '2026-07-05 21:38:13.19524+00', 'wez5hyieiwyl', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 11, 'uwjcgqs5ntpv', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-05 20:35:23.214793+00', '2026-07-05 22:43:21.159267+00', 'piwfuigu3wpa', 'f67dcb98-05aa-420f-9611-36f2792f1069'),
	('00000000-0000-0000-0000-000000000000', 12, '66bajbnbukiv', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-05 21:38:13.203723+00', '2026-07-06 01:40:37.862368+00', 'hr4g62xpxdhp', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 13, 'cuvvboqrzkxe', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-05 22:43:21.164199+00', '2026-07-06 03:43:44.618547+00', 'uwjcgqs5ntpv', 'f67dcb98-05aa-420f-9611-36f2792f1069'),
	('00000000-0000-0000-0000-000000000000', 14, 'a5zzru35o4t5', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-06 01:40:37.872354+00', '2026-07-07 02:53:05.239573+00', '66bajbnbukiv', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 16, 'ts4mau52g3jp', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-07 02:53:05.256143+00', '2026-07-08 10:10:22.744662+00', 'a5zzru35o4t5', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 17, 'wfpnw2xsst6r', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-08 10:10:22.765976+00', '2026-07-08 12:41:43.224904+00', 'ts4mau52g3jp', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 18, 'dahqt2nwh6v3', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', true, '2026-07-08 12:41:43.234+00', '2026-07-09 08:21:32.951437+00', 'wfpnw2xsst6r', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 19, '5zkkc6odfgnq', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', false, '2026-07-09 08:21:32.965114+00', '2026-07-09 08:21:32.965114+00', 'dahqt2nwh6v3', '8ae7b520-092c-4653-acb7-8727192d57d0'),
	('00000000-0000-0000-0000-000000000000', 15, 'mkvhlzoah4zc', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-07-06 03:43:44.62571+00', '2026-07-22 20:01:24.38441+00', 'cuvvboqrzkxe', 'f67dcb98-05aa-420f-9611-36f2792f1069'),
	('00000000-0000-0000-0000-000000000000', 20, '3hqhv2far5cu', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', false, '2026-07-22 20:01:24.400144+00', '2026-07-22 20:01:24.400144+00', 'mkvhlzoah4zc', 'f67dcb98-05aa-420f-9611-36f2792f1069'),
	('00000000-0000-0000-0000-000000000000', 22, 'vv7tqxuhctwl', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', false, '2026-09-18 19:30:16.602929+00', '2026-09-18 19:30:16.602929+00', NULL, '872c387a-6e3d-4eb2-ba29-c8eddaaeecc8'),
	('00000000-0000-0000-0000-000000000000', 23, '7ifx6ecvwgoq', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', false, '2026-09-18 19:31:04.420324+00', '2026-09-18 19:31:04.420324+00', NULL, '757cfc51-250b-4c31-9de4-304b0d7d34fb'),
	('00000000-0000-0000-0000-000000000000', 24, 'skq5wka7zb4r', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', false, '2026-09-18 19:31:23.283949+00', '2026-09-18 19:31:23.283949+00', NULL, 'c2133b7c-c5b2-46bf-ac15-9d3475eb8b14'),
	('00000000-0000-0000-0000-000000000000', 25, 'gkgpcqdxn6be', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', false, '2026-09-18 20:05:51.117676+00', '2026-09-18 20:05:51.117676+00', NULL, '4a5d669a-4d95-4411-9e0c-b2640ff85023'),
	('00000000-0000-0000-0000-000000000000', 26, 'cvwtowr5hmd4', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', false, '2026-09-18 23:40:49.699707+00', '2026-09-18 23:40:49.699707+00', NULL, '172b89bd-d693-4a51-afde-2869318a0b9e'),
	('00000000-0000-0000-0000-000000000000', 21, 'rbeugo74ua3j', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', true, '2026-09-18 17:59:49.974205+00', '2026-09-19 01:05:42.087633+00', NULL, 'c20d82eb-af0c-4dea-aeca-9a73db2987d1'),
	('00000000-0000-0000-0000-000000000000', 27, 'ibsdg4e4fz7p', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', false, '2026-09-19 01:05:42.102775+00', '2026-09-19 01:05:42.102775+00', 'rbeugo74ua3j', 'c20d82eb-af0c-4dea-aeca-9a73db2987d1');


--
-- Data for Name: sso_providers; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: saml_providers; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: saml_relay_states; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: scim_tokens; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: scim_users; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: sso_domains; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: webauthn_challenges; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: webauthn_credentials; Type: TABLE DATA; Schema: auth; Owner: supabase_auth_admin
--



--
-- Data for Name: decks; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."decks" ("id", "user_id", "name", "known_language", "learning_language", "created_at") VALUES
	('43072a4c-dc77-492e-9e74-3d5e37936002', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'Viet', 'en', 'vi', '2026-07-04 14:07:06.568'),
	('93e7acf3-80e4-4c96-89e2-c68bdd9e9ad0', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', 'Linh ', 'vi', 'en', '2026-07-05 01:47:23.41'),
	('93264b52-e1b8-40da-84c9-6008f0811ebf', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'English -> 한국어', 'en', 'ko', '2026-09-18 18:00:08.144'),
	('f733402b-b56a-4422-9da0-6e2ac398e4bd', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', 'Korean Phrases', 'en', 'ko', '2026-09-18 19:30:17.368778'),
	('669b557b-4467-46ef-8be4-5691f6715f0a', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'Korean Essentials', 'en', 'ko', '2026-09-19 01:05:48.15'),
	('8acbcbbd-4cb0-4825-bea4-ec03e6bb82c5', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'Spanish Essentials', 'en', 'es', '2026-09-19 01:05:50.18'),
	('6f36a50f-5ca7-461a-bcde-7e32c5d9f47f', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 'English -> 中文', 'en', 'zh_cn', '2026-09-19 01:08:00.721');


--
-- Data for Name: cards; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."cards" ("id", "deck_id", "position", "front_text", "back_text", "front_audio_path", "back_audio_path", "front_lang", "back_lang", "created_at") VALUES
	('367e0a59-f14d-4b97-b009-757b1cf6e79e', '43072a4c-dc77-492e-9e74-3d5e37936002', 1, 'Water bottle', 'chai nước', '1783174738972_front_1a55959f.mp3', '1783174749427_back_cbf6fa07.mp3', 'en', 'vi', '2026-07-04 14:20:13.721'),
	('8c12247b-7ff3-4a50-9478-60b85b857774', '43072a4c-dc77-492e-9e74-3d5e37936002', 2, 'chai nước', 'Water bottle', '1783174749427_back_cbf6fa07.mp3', '1783174738972_front_1a55959f.mp3', 'vi', 'en', '2026-07-04 14:20:13.721'),
	('1351a1b7-d51f-48b4-a720-d1f8474d239d', '43072a4c-dc77-492e-9e74-3d5e37936002', 3, 'oxygen', 'oxi', '1783212861349_front_c682a76a.mp3', '1783212865439_back_6f6adacb.mp3', 'en', 'vi', '2026-07-05 00:54:35.452'),
	('98f9053a-7992-45ec-a803-ef92dd94e3c4', '43072a4c-dc77-492e-9e74-3d5e37936002', 4, 'oxi', 'oxygen', '1783212865439_back_6f6adacb.mp3', '1783212861349_front_c682a76a.mp3', 'vi', 'en', '2026-07-05 00:54:35.452'),
	('edc4a395-469a-4898-b004-0efefd9cd35b', '93e7acf3-80e4-4c96-89e2-c68bdd9e9ad0', 1, 'Thoải mái', 'comfortable', '1783216084632_front_26025b8d.mp3', '1783216084537_back_32e099fb.mp3', 'vi', 'en', '2026-07-05 01:48:45.138'),
	('f44a428e-241c-4055-a285-af258b170dd1', '93e7acf3-80e4-4c96-89e2-c68bdd9e9ad0', 2, 'comfortable', 'Thoải mái', '1783216084537_back_32e099fb.mp3', '1783216084632_front_26025b8d.mp3', 'en', 'vi', '2026-07-05 01:48:45.138'),
	('08b0b778-facb-48a4-8397-bba162a743ab', '93264b52-e1b8-40da-84c9-6008f0811ebf', 1, 'Are you crazy?', '미쳤어?', '1789754446095_front_44ec7350.mp3', '1789754443816_back_dc3b2354.mp3', 'en', 'ko', '2026-09-18 18:00:58.711'),
	('e3f45e11-5ef6-44cb-91d8-881f016043e5', '93264b52-e1b8-40da-84c9-6008f0811ebf', 2, '미쳤어?', 'Are you crazy?', '1789754443816_back_dc3b2354.mp3', '1789754446095_front_44ec7350.mp3', 'ko', 'en', '2026-09-18 18:00:58.711'),
	('47bb4453-c01e-4d2e-9a53-14b09f21b185', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 1, 'Hello', '안녕하세요', '1789759817427_front_tisb83rd.wav', '1789759817427_back_ryyaplxv.wav', 'en', 'ko', '2026-09-18 19:30:21.060203'),
	('58664069-1d2b-4a90-bc5e-dd3ea1c3623c', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 2, '안녕하세요', 'Hello', '1789759821245_front_l5g314pp.wav', '1789759821245_back_b93ies3t.wav', 'ko', 'en', '2026-09-18 19:30:24.130591'),
	('9a9d1167-36eb-498d-9eec-ad02c2a42f05', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 3, 'Thank you', '감사합니다', '1789759824430_front_8cfqgdh1.wav', '1789759824430_back_nbtqiyp8.wav', 'en', 'ko', '2026-09-18 19:30:27.404198'),
	('3c478260-73cd-4e1a-8bd0-9f613742e736', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 4, '감사합니다', 'Thank you', '1789759827559_front_ykebhmfg.wav', '1789759827559_back_9ktown4x.wav', 'ko', 'en', '2026-09-18 19:30:30.574644'),
	('d2b97149-1b32-40e4-aeb8-844a0c41777c', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 5, 'Nice to meet you', '반갑습니다', '1789759830723_front_hphhd7s3.wav', '1789759830723_back_zwmcmr9a.wav', 'en', 'ko', '2026-09-18 19:30:33.477655'),
	('ce315001-fcdb-4a97-a12e-97fa7bbee539', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 6, '반갑습니다', 'Nice to meet you', '1789759833630_front_a199dy4r.wav', '1789759833630_back_jozsjsrf.wav', 'ko', 'en', '2026-09-18 19:30:36.704694'),
	('40aedc0b-99bf-45ff-8e0a-828b47fe825e', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 7, 'How much is this?', '이거 얼마예요?', '1789759836871_front_2whx1qjs.wav', '1789759836871_back_jnldlwt2.wav', 'en', 'ko', '2026-09-18 19:30:39.574182'),
	('4a5914df-c4b7-4feb-aff2-b228a9b53b17', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 8, '이거 얼마예요?', 'How much is this?', '1789759839722_front_qcmwls11.wav', '1789759839722_back_9qsq6hzv.wav', 'ko', 'en', '2026-09-18 19:30:42.599798'),
	('81faf3c8-87a3-4f23-b77c-2a74eec22431', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 9, 'I''m hungry', '배고파요', '1789759842750_front_e7398gk1.wav', '1789759842750_back_68fx7x1a.wav', 'en', 'ko', '2026-09-18 19:30:45.615769'),
	('aece4a9c-b848-4793-869a-a13ae02f7f75', 'f733402b-b56a-4422-9da0-6e2ac398e4bd', 10, '배고파요', 'I''m hungry', '1789759845761_front_ra8vyviz.wav', '1789759845761_back_1p5m6ycl.wav', 'ko', 'en', '2026-09-18 19:30:48.459474'),
	('95304457-8fb2-427f-b5dd-d109a3d6fd08', '669b557b-4467-46ef-8be4-5691f6715f0a', 1, 'water ', '물', '1789779981542_front_aef55179.mp3', '1789779981012_back_edb0a5d5.mp3', 'en', 'ko', '2026-09-19 01:06:31.151'),
	('f4f135a1-8c16-427e-8490-2e5e1813c831', '669b557b-4467-46ef-8be4-5691f6715f0a', 2, '물', 'water ', '1789779981012_back_edb0a5d5.mp3', '1789779981542_front_aef55179.mp3', 'ko', 'en', '2026-09-19 01:06:31.151'),
	('2bbfe0dc-f0cc-42e7-8af1-1e4018cf9c0c', '6f36a50f-5ca7-461a-bcde-7e32c5d9f47f', 1, 'baby (infant)', '宝宝', '1789780142941_front_0866705b.mp3', '1789780144195_back_633f4532.mp3', 'en', 'zh_cn', '2026-09-19 01:10:11.672'),
	('268a2b12-92eb-49bd-aa1d-560dc87f8074', '6f36a50f-5ca7-461a-bcde-7e32c5d9f47f', 2, '宝宝', 'baby (infant)', '1789780144195_back_633f4532.mp3', '1789780142941_front_0866705b.mp3', 'zh_cn', 'en', '2026-09-19 01:10:11.672');


--
-- Data for Name: review_logs; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."review_logs" ("id", "card_id", "user_id", "reviewed_at", "rating", "card_state", "interval_days", "ease_factor", "repetitions", "elapsed_days", "scheduled_days") VALUES
	('011352c9-b334-404e-b560-7f5d00d5f9d1', '95304457-8fb2-427f-b5dd-d109a3d6fd08', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-19 01:07:00.8+00', 'good', 'new', 1, 2.5, 0, NULL, 0),
	('894bd65d-d7d3-46d3-b551-6df363e23d93', 'f4f135a1-8c16-427e-8490-2e5e1813c831', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-19 01:07:14.149+00', 'good', 'new', 1, 2.5, 0, NULL, 0);


--
-- Data for Name: reviews; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."reviews" ("id", "card_id", "user_id", "scheduled_date", "interval_days", "ease_factor", "repetitions", "last_reviewed_at", "next_review_date", "card_state", "learning_step", "lapses") VALUES
	('43f860b2-dc81-49ef-91c7-7569a57cad83', '367e0a59-f14d-4b97-b009-757b1cf6e79e', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-04', 1, 2.5, 2, '2026-07-05 01:39:07.729+00', '2026-07-05 01:49:07.727+00', 'learning', 0, 0),
	('f0a30818-d208-4324-8991-b916f0edfa35', '8c12247b-7ff3-4a50-9478-60b85b857774', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-04', 1, 2.5, 2, '2026-07-05 01:40:26.509+00', '2026-07-06 01:40:26.508+00', 'review', 0, 0),
	('0eeddab5-9d4e-4356-b0e7-b041e11f3ff8', '1351a1b7-d51f-48b4-a720-d1f8474d239d', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-05', 1, 2.5, 2, '2026-07-05 01:41:07.258+00', '2026-07-05 01:51:07.257+00', 'learning', 0, 0),
	('3a3cd1ce-3fee-4cb3-8692-4b41c4149e9c', '98f9053a-7992-45ec-a803-ef92dd94e3c4', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-07-05', 1, 2.5, 1, '2026-07-05 01:41:32.413+00', '2026-07-05 01:51:32.411+00', 'learning', 0, 0),
	('68cfec6d-7884-4c56-bbe8-d1548c89f505', 'f44a428e-241c-4055-a285-af258b170dd1', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', '2026-07-05', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('377c2b32-7ae6-4eb6-a725-f9a6ac73650e', 'edc4a395-469a-4898-b004-0efefd9cd35b', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', '2026-07-05', 1, 2.5, 1, '2026-07-05 01:51:45.056+00', '2026-07-05 02:01:45.053+00', 'learning', 0, 0),
	('96129fb1-d844-4f16-8467-5dc6fb2c4fd6', '08b0b778-facb-48a4-8397-bba162a743ab', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('c5b7736d-8add-4864-9d81-cd043bdf2e7a', 'e3f45e11-5ef6-44cb-91d8-881f016043e5', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('f89b9ef9-732e-4f84-833b-83d68d53eb0a', '47bb4453-c01e-4d2e-9a53-14b09f21b185', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('32e11eb0-db37-4396-9c8c-5361c33b0747', '58664069-1d2b-4a90-bc5e-dd3ea1c3623c', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('ef997f97-9764-470d-b0b6-9c82922ddd9c', '9a9d1167-36eb-498d-9eec-ad02c2a42f05', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('39cd8dc3-a6d9-47ae-a576-f238d5e57254', '3c478260-73cd-4e1a-8bd0-9f613742e736', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('fe0fc49b-595c-4c12-80e1-e9ddcfce678f', 'd2b97149-1b32-40e4-aeb8-844a0c41777c', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('703496b0-7826-41d0-b051-4fd3027a877c', 'ce315001-fcdb-4a97-a12e-97fa7bbee539', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('999150e4-9bf1-454e-9c22-aed67692c5d7', '40aedc0b-99bf-45ff-8e0a-828b47fe825e', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('7e19fafc-ad32-407d-a1e5-70fc933c5a11', '4a5914df-c4b7-4feb-aff2-b228a9b53b17', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('f7b0acc5-2026-4470-ad5b-b5b0f5fa0251', '81faf3c8-87a3-4f23-b77c-2a74eec22431', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('8d6b0e91-91ac-4ea2-a00b-68fe08d76a52', 'aece4a9c-b848-4793-869a-a13ae02f7f75', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('bc15377d-f41b-4e5e-b114-05bf3df04d25', '95304457-8fb2-427f-b5dd-d109a3d6fd08', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18', 1, 2.5, 1, '2026-09-19 01:07:00.8+00', '2026-09-19 01:17:00.8+00', 'learning', 1, 0),
	('c26a7811-42e8-4737-8fc8-f8b5796fe078', 'f4f135a1-8c16-427e-8490-2e5e1813c831', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18', 1, 2.5, 1, '2026-09-19 01:07:14.149+00', '2026-09-19 01:17:14.149+00', 'learning', 1, 0),
	('046f8480-31e4-44f7-8e6f-f9f9ed3a6029', '2bbfe0dc-f0cc-42e7-8af1-1e4018cf9c0c', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0),
	('42fe9d12-f0f9-4770-937a-0acd9fca11dc', '268a2b12-92eb-49bd-aa1d-560dc87f8074', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '2026-09-18', 1, 2.5, 0, NULL, NULL, 'new', 0, 0);


--
-- Data for Name: subscription_tiers; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."subscription_tiers" ("id", "name", "realtime_sessions_limit", "voice_evaluations_limit", "card_audio_generations_limit", "stripe_price_id", "created_at") VALUES
	('89635c02-44de-4b55-9d32-b40ac815ab88', 'Free', 5, 100, 100, 'price_free', '2026-07-04 13:27:32.869165'),
	('a12bee23-6806-4d8a-b117-94dad3febbf1', 'Standard', 60, 1000, 1000, 'price_1R38iGDkEAsn6R9yOrSesptN', '2026-07-04 13:27:32.869165'),
	('adf2c9a6-e1d9-4d28-9feb-34d37d2c6bac', 'Pro', -1, -1, -1, 'price_1R38iGDkEAsn6R9yLhLsWk2x', '2026-07-04 13:27:32.869165'),
	('5218108f-a631-49e4-bb4a-d083b67bc3e4', 'Standard test', 5, 100, 100, 'price_1R38OhDkEAsn6R9y1QKRQkhu', '2026-07-04 13:27:32.869165'),
	('04b7cfd5-381a-4840-a76b-5a0c17bde24e', 'Pro test', -1, -1, -1, 'price_1R38gcDkEAsn6R9yXj64T8MH', '2026-07-04 13:27:32.869165');


--
-- Data for Name: usage_tracking; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."usage_tracking" ("id", "user_id", "realtime_sessions_started", "voice_evaluations_used", "card_audio_generations_used", "created_at", "updated_at") VALUES
	('7db966d9-1ee7-4dd2-ad75-44054fbb0379', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', 0, 1, 2, '2026-07-05 01:44:28.222248', '2026-07-05 01:44:28.222248'),
	('b5160cc5-61f2-4ace-863c-383fab019786', 'f17ac20c-5e23-4e4f-86cb-fd48374ca0a7', 0, 0, 0, '2026-09-18 18:10:41.479137', '2026-09-18 18:10:41.479137'),
	('5b2474de-78c4-4249-b787-4de2a5c3319e', '7abea1d0-ad2c-4333-8a66-162a510db296', 0, 0, 0, '2026-09-18 18:11:03.296196', '2026-09-18 18:11:03.296196'),
	('021b0863-e3e0-4434-9a0b-bc57ab26ea5c', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', 0, 0, 22, '2026-09-18 19:30:15.803711', '2026-09-18 19:30:15.803711'),
	('09de5005-b49f-468b-92aa-90b4542bba19', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', 0, 1, 14, '2026-07-04 14:06:21.077895', '2026-07-04 14:06:21.077895');


--
-- Data for Name: user_preferences; Type: TABLE DATA; Schema: public; Owner: postgres
--



--
-- Data for Name: user_subscriptions; Type: TABLE DATA; Schema: public; Owner: postgres
--

INSERT INTO "public"."user_subscriptions" ("id", "user_id", "tier_id", "stripe_subscription_id", "stripe_customer_id", "current_period_start", "current_period_end", "status", "created_at", "updated_at") VALUES
	('a47d5e9e-a6c0-41d3-b020-83ed4a448bf2', 'dc1aac9b-8cac-4e30-acdf-ddfaceb49b72', '89635c02-44de-4b55-9d32-b40ac815ab88', NULL, NULL, '2026-07-04 14:06:21.077895', '2026-08-04 14:06:21.077895', 'active', '2026-07-04 14:06:21.077895', '2026-07-04 14:06:21.077895'),
	('6df7c957-f728-4e72-9b65-56fdbce25eb2', 'fd94820f-6c1a-4e0b-a175-f376c7dce351', '89635c02-44de-4b55-9d32-b40ac815ab88', NULL, NULL, '2026-07-05 01:44:28.222248', '2026-08-05 01:44:28.222248', 'active', '2026-07-05 01:44:28.222248', '2026-07-05 01:44:28.222248'),
	('813d1ba7-37a0-4e59-91c2-bcf9cdbad467', 'f17ac20c-5e23-4e4f-86cb-fd48374ca0a7', '89635c02-44de-4b55-9d32-b40ac815ab88', NULL, NULL, '2026-09-18 18:10:41.479137', '2026-10-18 18:10:41.479137', 'active', '2026-09-18 18:10:41.479137', '2026-09-18 18:10:41.479137'),
	('96993396-a74d-4829-baf9-f7e8a0d633e2', '7abea1d0-ad2c-4333-8a66-162a510db296', '89635c02-44de-4b55-9d32-b40ac815ab88', NULL, NULL, '2026-09-18 18:11:03.296196', '2026-10-18 18:11:03.296196', 'active', '2026-09-18 18:11:03.296196', '2026-09-18 18:11:03.296196'),
	('861111ff-bf05-4787-a381-ef2e356c5417', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '89635c02-44de-4b55-9d32-b40ac815ab88', NULL, NULL, '2026-09-18 19:30:15.803711', '2026-10-18 19:30:15.803711', 'active', '2026-09-18 19:30:15.803711', '2026-09-18 19:30:15.803711');


--
-- Data for Name: buckets; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

INSERT INTO "storage"."buckets" ("id", "name", "owner", "created_at", "updated_at", "public", "avif_autodetection", "file_size_limit", "allowed_mime_types", "owner_id", "type", "versioning_status") VALUES
	('card-audio', 'card-audio', NULL, '2026-07-04 13:27:32.869165+00', '2026-07-04 13:27:32.869165+00', true, false, NULL, NULL, NULL, 'STANDARD', 'DISABLED');


--
-- Data for Name: buckets_analytics; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--



--
-- Data for Name: buckets_vectors; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--



--
-- Data for Name: objects; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--

INSERT INTO "storage"."objects" ("id", "bucket_id", "name", "owner", "created_at", "updated_at", "last_accessed_at", "metadata", "version", "owner_id", "user_metadata", "archived_at", "is_delete_marker", "is_versioned") VALUES
	('38e583ae-547c-4f5a-966a-3332a5e0de3b', 'card-audio', '1783174738972_front_1a55959f.mp3', NULL, '2026-07-04 14:18:59.288325+00', '2026-07-04 14:18:59.288325+00', '2026-07-04 14:18:59.288325+00', '{"eTag": "\"555254d62cb7ac6e04cc268baa2ee99d\"", "size": 33792, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-04T14:19:00.000Z", "contentLength": 33792, "httpStatusCode": 200}', '54b381d8-0bff-4d15-b9d1-342a768fbe08', NULL, '{}', NULL, false, false),
	('b481dbf6-5d03-4307-8949-89c322574caf', 'card-audio', '1789779981012_back_edb0a5d5.mp3', NULL, '2026-09-19 01:06:21.182714+00', '2026-09-19 01:06:21.182714+00', '2026-09-19 01:06:21.182714+00', '{"eTag": "\"3ba574d5e17fade65efc9a382f5e72af\"", "size": 17664, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-19T01:06:22.000Z", "contentLength": 17664, "httpStatusCode": 200}', 'cd06bc1f-8489-4723-bc63-22a36389c768', NULL, '{}', NULL, false, false),
	('66fe41d7-57a2-43c0-8a88-b2c17b74b446', 'card-audio', '1783174749427_back_cbf6fa07.mp3', NULL, '2026-07-04 14:19:09.833637+00', '2026-07-04 14:19:09.833637+00', '2026-07-04 14:19:09.833637+00', '{"eTag": "\"ce2705ad3698344ae3aa20834db65ff6\"", "size": 26496, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-04T14:19:10.000Z", "contentLength": 26496, "httpStatusCode": 200}', '2f5fb7de-002c-41c3-9ece-a5e78db14390', NULL, '{}', NULL, false, false),
	('90e526d6-4a79-4177-80bf-fdba1306c586', 'card-audio', '1783174907020_front_48e15169.mp3', NULL, '2026-07-04 14:21:47.166451+00', '2026-07-04 14:21:47.166451+00', '2026-07-04 14:21:47.166451+00', '{"eTag": "\"c89189deee838db18ab45c22c6c75f84\"", "size": 16896, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-04T14:21:48.000Z", "contentLength": 16896, "httpStatusCode": 200}', '23adb7e5-4f44-4970-81c4-af449a07258e', NULL, '{}', NULL, false, false),
	('53377792-8f8c-458e-bbb1-ca4448e4403c', 'card-audio', '1789779981542_front_aef55179.mp3', NULL, '2026-09-19 01:06:21.660604+00', '2026-09-19 01:06:21.660604+00', '2026-09-19 01:06:21.660604+00', '{"eTag": "\"37dd0d75b836b60ed3305dbb1f990fdd\"", "size": 44160, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-19T01:06:22.000Z", "contentLength": 44160, "httpStatusCode": 200}', '42de9f07-f01b-4d9c-96c0-2915c74dd7f6', NULL, '{}', NULL, false, false),
	('d5f14417-8e3a-4105-9530-d42aad2aa4f1', 'card-audio', '1783174961909_front_3f3a5528.mp3', NULL, '2026-07-04 14:22:42.34974+00', '2026-07-04 14:22:42.34974+00', '2026-07-04 14:22:42.34974+00', '{"eTag": "\"d9fffc95f9cd35e87f21ad208e7b55b7\"", "size": 19200, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-04T14:22:43.000Z", "contentLength": 19200, "httpStatusCode": 200}', '9bd8f9d3-c9f1-489c-9318-fa58a182cbd5', NULL, '{}', NULL, false, false),
	('eceacc78-5357-4b2f-ae66-159939b9f882', 'card-audio', '1783175016889_front_950c77bd.mp3', NULL, '2026-07-04 14:23:37.038105+00', '2026-07-04 14:23:37.038105+00', '2026-07-04 14:23:37.038105+00', '{"eTag": "\"30f92933078475a5b536a1af19d5a227\"", "size": 31488, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-04T14:23:38.000Z", "contentLength": 31488, "httpStatusCode": 200}', 'fe4b2bb4-5502-44f6-a487-1d9f6e45d252', NULL, '{}', NULL, false, false),
	('a55d0c6a-62c6-4505-9591-45bacf7dbacf', 'card-audio', '1789780142941_front_0866705b.mp3', NULL, '2026-09-19 01:09:03.072315+00', '2026-09-19 01:09:03.072315+00', '2026-09-19 01:09:03.072315+00', '{"eTag": "\"6994fa1dc2462a0e36ced84bd8c7badb\"", "size": 19968, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-19T01:09:04.000Z", "contentLength": 19968, "httpStatusCode": 200}', 'c97e0ec9-cd2c-48be-ad1c-6ac11b9e9e3f', NULL, '{}', NULL, false, false),
	('313624b3-2e12-4d33-b0aa-140589f6abaf', 'card-audio', '1783210617190_front_f202ab94.mp3', NULL, '2026-07-05 00:16:57.477689+00', '2026-07-05 00:16:57.477689+00', '2026-07-05 00:16:57.477689+00', '{"eTag": "\"188707c9bdfe3d74eea01d17809fa523\"", "size": 18432, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T00:16:58.000Z", "contentLength": 18432, "httpStatusCode": 200}', 'a9e72124-46ce-4ddc-a885-a00a1e4560ce', NULL, '{}', NULL, false, false),
	('1bbff3b7-e3a2-4d8d-829c-28bb35c1a844', 'card-audio', '1783211584681_front_110923ff.mp3', NULL, '2026-07-05 00:33:05.207055+00', '2026-07-05 00:33:05.207055+00', '2026-07-05 00:33:05.207055+00', '{"eTag": "\"e5ae855f17ab7b22f3f79f242e2fc392\"", "size": 27264, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T00:33:06.000Z", "contentLength": 27264, "httpStatusCode": 200}', '205acf39-6035-46ec-a723-d43419a5c292', NULL, '{}', NULL, false, false),
	('ce1481bf-acb9-49b5-9f7a-79d2e6480ccc', 'card-audio', '1789780144195_back_633f4532.mp3', NULL, '2026-09-19 01:09:04.566024+00', '2026-09-19 01:09:04.566024+00', '2026-09-19 01:09:04.566024+00', '{"eTag": "\"d7ef75994743890aa55cfd224d23f218\"", "size": 16896, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-19T01:09:05.000Z", "contentLength": 16896, "httpStatusCode": 200}', 'b22014ca-42ce-4ad9-8ad2-b18d47b742ba', NULL, '{}', NULL, false, false),
	('7f2f7465-1661-4b83-a58e-5a2bff89ef51', 'card-audio', '1783211586357_back_e7d6de9b.mp3', NULL, '2026-07-05 00:33:07.01668+00', '2026-07-05 00:33:07.01668+00', '2026-07-05 00:33:07.01668+00', '{"eTag": "\"d3f981ecbab79d55cc1fd6b98c5f16c4\"", "size": 39168, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T00:33:07.000Z", "contentLength": 39168, "httpStatusCode": 200}', '955b1a41-55c8-42b1-bd95-75cbb150aa54', NULL, '{}', NULL, false, false),
	('19730843-d7df-4a42-bef0-224c90f57cd9', 'card-audio', '1783212861349_front_c682a76a.mp3', NULL, '2026-07-05 00:54:21.769589+00', '2026-07-05 00:54:21.769589+00', '2026-07-05 00:54:21.769589+00', '{"eTag": "\"3680073f9610b9e0f83b2e73dd4ad2ef\"", "size": 16128, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T00:54:22.000Z", "contentLength": 16128, "httpStatusCode": 200}', '1f2f520e-a510-4b02-8ea8-c46ae1f56bcb', NULL, '{}', NULL, false, false),
	('9a6851bc-a142-49ea-b553-677f70415a2b', 'card-audio', '1783212865439_back_6f6adacb.mp3', NULL, '2026-07-05 00:54:25.582089+00', '2026-07-05 00:54:25.582089+00', '2026-07-05 00:54:25.582089+00', '{"eTag": "\"29dd9bd132774c0b0a26b64ffaa90873\"", "size": 17664, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T00:54:26.000Z", "contentLength": 17664, "httpStatusCode": 200}', '4cbf0dd8-c172-4a96-80f0-69b2f7d86b16', NULL, '{}', NULL, false, false),
	('a1e38214-9e48-4eef-945a-7a15092c76a3', 'card-audio', '1783216084537_back_32e099fb.mp3', NULL, '2026-07-05 01:48:04.789981+00', '2026-07-05 01:48:04.789981+00', '2026-07-05 01:48:04.789981+00', '{"eTag": "\"9f23fc2fe66a57185ab528050033e700\"", "size": 14592, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T01:48:05.000Z", "contentLength": 14592, "httpStatusCode": 200}', '4a427c09-fea4-422a-9e31-fc6dd7d7072f', NULL, '{}', NULL, false, false),
	('38b18bb9-cdd0-4611-95c3-d4db45b5623b', 'card-audio', '1783216084632_front_26025b8d.mp3', NULL, '2026-07-05 01:48:04.797071+00', '2026-07-05 01:48:04.797071+00', '2026-07-05 01:48:04.797071+00', '{"eTag": "\"a10c5874dcbbcb21641189120a6d4188\"", "size": 23424, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-07-05T01:48:05.000Z", "contentLength": 23424, "httpStatusCode": 200}', 'e4257209-6f6b-4e33-8b51-3ded664fbb33', NULL, '{}', NULL, false, false),
	('fb5ed7f1-3069-4c5c-97a4-c0c03a291a45', 'card-audio', '1789754443816_back_dc3b2354.mp3', NULL, '2026-09-18 18:00:44.051588+00', '2026-09-18 18:00:44.051588+00', '2026-09-18 18:00:44.051588+00', '{"eTag": "\"a16db718931721f52c5571209626f905\"", "size": 38400, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T18:00:44.000Z", "contentLength": 38400, "httpStatusCode": 200}', '3803de64-303c-400d-95db-7c814352c1c1', NULL, '{}', NULL, false, false),
	('3fd68762-5e64-483a-955e-e31cb9b6802e', 'card-audio', '1789754446095_front_44ec7350.mp3', NULL, '2026-09-18 18:00:46.234601+00', '2026-09-18 18:00:46.234601+00', '2026-09-18 18:00:46.234601+00', '{"eTag": "\"53e228f52a9afdf5c1c24ff2f3dd9e4a\"", "size": 25728, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T18:00:47.000Z", "contentLength": 25728, "httpStatusCode": 200}', '1ca220dc-5589-4b46-917c-763fc48c59ab', NULL, '{}', NULL, false, false),
	('1e149540-06ca-4623-945c-3553433a936d', 'card-audio', '1789759817427_front_tisb83rd.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:19.367004+00', '2026-09-18 19:30:19.367004+00', '2026-09-18 19:30:19.367004+00', '{"eTag": "\"5a0b097754a5000a621769fb500b0668\"", "size": 35696, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:20.000Z", "contentLength": 35696, "httpStatusCode": 200}', 'cbb41e26-92c4-45fd-871f-97a9c36b594f', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('8c0c0c5d-8641-41c9-8b73-997328010f6d', 'card-audio', '1789759817427_back_ryyaplxv.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:20.787005+00', '2026-09-18 19:30:20.787005+00', '2026-09-18 19:30:20.787005+00', '{"eTag": "\"e8ddb46948cc960e3c953be41b5ed846\"", "size": 52112, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:21.000Z", "contentLength": 52112, "httpStatusCode": 200}', 'd4e29c0b-858b-424b-b084-a37b1b14b41d', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('fd168d93-44d5-4f74-a3e9-901a9a9ac757', 'card-audio', '1789759821245_front_l5g314pp.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:22.730387+00', '2026-09-18 19:30:22.730387+00', '2026-09-18 19:30:22.730387+00', '{"eTag": "\"e8ddb46948cc960e3c953be41b5ed846\"", "size": 52112, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:23.000Z", "contentLength": 52112, "httpStatusCode": 200}', '2c3cc45b-6c52-4ad2-a769-ff129c71ca15', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('237f274e-4f21-46f0-b0ae-6961c810fa6a', 'card-audio', '1789759821245_back_b93ies3t.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:23.988954+00', '2026-09-18 19:30:23.988954+00', '2026-09-18 19:30:23.988954+00', '{"eTag": "\"5a0b097754a5000a621769fb500b0668\"", "size": 35696, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:24.000Z", "contentLength": 35696, "httpStatusCode": 200}', '99e96242-4251-4b3d-923d-07d1744df9fc', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('9be32424-c7e2-43dd-8888-36183e185b77', 'card-audio', '1789759824430_front_8cfqgdh1.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:25.793799+00', '2026-09-18 19:30:25.793799+00', '2026-09-18 19:30:25.793799+00', '{"eTag": "\"29c3bd2808a1ec151a18332778f3c889\"", "size": 40000, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:26.000Z", "contentLength": 40000, "httpStatusCode": 200}', 'ae478365-1d00-4270-b0f7-48d4daba7bc5', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('293384e4-f1a4-4960-84a3-73e7782e8fce', 'card-audio', '1789759824430_back_nbtqiyp8.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:27.272384+00', '2026-09-18 19:30:27.272384+00', '2026-09-18 19:30:27.272384+00', '{"eTag": "\"df78fb94902db0996af1be7a6e1184f6\"", "size": 51022, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:28.000Z", "contentLength": 51022, "httpStatusCode": 200}', '68119505-1580-46c6-b7b2-21968f822515', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('b7e6e84b-291a-4c70-8fe1-fe94fdcbf2fb', 'card-audio', '1789759827559_front_ykebhmfg.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:28.865752+00', '2026-09-18 19:30:28.865752+00', '2026-09-18 19:30:28.865752+00', '{"eTag": "\"df78fb94902db0996af1be7a6e1184f6\"", "size": 51022, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:29.000Z", "contentLength": 51022, "httpStatusCode": 200}', '5dc00437-0fa9-40c0-a3d6-3559853dbace', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('a5da7249-626e-439b-ae0f-b4c44bf4293c', 'card-audio', '1789759827559_back_9ktown4x.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:30.428517+00', '2026-09-18 19:30:30.428517+00', '2026-09-18 19:30:30.428517+00', '{"eTag": "\"29c3bd2808a1ec151a18332778f3c889\"", "size": 40000, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:31.000Z", "contentLength": 40000, "httpStatusCode": 200}', '8765d098-15f6-43c5-8883-67c0b04775af', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('fa81d6dc-5a15-4541-88b8-f109acdb5f8c', 'card-audio', '1789759830723_front_hphhd7s3.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:32.021524+00', '2026-09-18 19:30:32.021524+00', '2026-09-18 19:30:32.021524+00', '{"eTag": "\"ca4ae94f56e7bcf42194ba18f5d48169\"", "size": 57550, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:32.000Z", "contentLength": 57550, "httpStatusCode": 200}', 'd1541bf5-3a80-4f31-bb95-937f6575c818', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('57e50cc6-6155-4e59-b2fb-55834d47f444', 'card-audio', '1789759830723_back_zwmcmr9a.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:33.35061+00', '2026-09-18 19:30:33.35061+00', '2026-09-18 19:30:33.35061+00', '{"eTag": "\"7e96f1b9e9382f1741963f52582660fe\"", "size": 54614, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:34.000Z", "contentLength": 54614, "httpStatusCode": 200}', '7785c863-1e47-4421-a256-c42fb98ea253', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('5969215d-9183-4b8f-9d48-40e41ab80d07', 'card-audio', '1789759833630_front_a199dy4r.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:35.123082+00', '2026-09-18 19:30:35.123082+00', '2026-09-18 19:30:35.123082+00', '{"eTag": "\"7e96f1b9e9382f1741963f52582660fe\"", "size": 54614, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:36.000Z", "contentLength": 54614, "httpStatusCode": 200}', 'fadc0742-7691-47d6-a57f-90b5d193e43a', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('6fbeb301-12db-49c8-8b01-1c51f145c9e6', 'card-audio', '1789759833630_back_jozsjsrf.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:36.550399+00', '2026-09-18 19:30:36.550399+00', '2026-09-18 19:30:36.550399+00', '{"eTag": "\"ca4ae94f56e7bcf42194ba18f5d48169\"", "size": 57550, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:37.000Z", "contentLength": 57550, "httpStatusCode": 200}', '50074524-2051-4139-8bef-2c55eddaa09c', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('0942b995-e6af-4a57-8356-5560c45face1', 'card-audio', '1789759836871_front_2whx1qjs.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:38.150474+00', '2026-09-18 19:30:38.150474+00', '2026-09-18 19:30:38.150474+00', '{"eTag": "\"18fd830902cab995aa8ebc5c82fd59c1\"", "size": 56690, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:39.000Z", "contentLength": 56690, "httpStatusCode": 200}', '9ec90b4d-ec3a-4b08-af3d-53a972658eb0', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('b684e4b6-104b-4514-ba89-683f08360da6', 'card-audio', '1789759836871_back_jnldlwt2.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:39.457417+00', '2026-09-18 19:30:39.457417+00', '2026-09-18 19:30:39.457417+00', '{"eTag": "\"b289967571466cb7e5e0a6d10d3a89c0\"", "size": 53134, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:40.000Z", "contentLength": 53134, "httpStatusCode": 200}', 'c266f074-868c-439d-9e1d-397d2871c132', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('7ceb4455-6611-4f81-b7f6-cb79a39678c9', 'card-audio', '1789759839722_front_qcmwls11.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:40.99051+00', '2026-09-18 19:30:40.99051+00', '2026-09-18 19:30:40.99051+00', '{"eTag": "\"b289967571466cb7e5e0a6d10d3a89c0\"", "size": 53134, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:41.000Z", "contentLength": 53134, "httpStatusCode": 200}', '349c59fe-8c90-444f-9810-e26d5a2d7e02', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('396284fa-8daa-4792-ba44-58aed6e40276', 'card-audio', '1789759839722_back_9qsq6hzv.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:42.482511+00', '2026-09-18 19:30:42.482511+00', '2026-09-18 19:30:42.482511+00', '{"eTag": "\"18fd830902cab995aa8ebc5c82fd59c1\"", "size": 56690, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:43.000Z", "contentLength": 56690, "httpStatusCode": 200}', 'b52d5f6a-2e12-4186-81bc-ce1b81213151', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('6c24989d-29ce-4f97-a383-9ba930e0e8c8', 'card-audio', '1789759842750_front_e7398gk1.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:44.058779+00', '2026-09-18 19:30:44.058779+00', '2026-09-18 19:30:44.058779+00', '{"eTag": "\"40b9e7e1f6553f7671a35b09e5c7423d\"", "size": 42326, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:45.000Z", "contentLength": 42326, "httpStatusCode": 200}', 'e4c3c881-6523-4855-a2d6-294e80153bec', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('3387973f-94e2-4ebb-a5eb-fce047fb2dfc', 'card-audio', '1789759842750_back_68fx7x1a.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:45.491137+00', '2026-09-18 19:30:45.491137+00', '2026-09-18 19:30:45.491137+00', '{"eTag": "\"16dc8771f0158141c8e13f597a741fe3\"", "size": 46078, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:46.000Z", "contentLength": 46078, "httpStatusCode": 200}', 'd5350530-d15e-42c1-bf18-ba6f21f5494c', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('5bf5ad13-23a9-4393-af78-b3efcef297d4', 'card-audio', '1789759845761_front_ra8vyviz.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:47.060223+00', '2026-09-18 19:30:47.060223+00', '2026-09-18 19:30:47.060223+00', '{"eTag": "\"16dc8771f0158141c8e13f597a741fe3\"", "size": 46078, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:48.000Z", "contentLength": 46078, "httpStatusCode": 200}', '2f9bf71f-c99e-4bab-bfe5-78354bc502c9', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('03d1ceff-c46e-485b-a51c-7562b0feda87', 'card-audio', '1789759845761_back_1p5m6ycl.wav', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '2026-09-18 19:30:48.330258+00', '2026-09-18 19:30:48.330258+00', '2026-09-18 19:30:48.330258+00', '{"eTag": "\"40b9e7e1f6553f7671a35b09e5c7423d\"", "size": 42326, "mimetype": "audio/wav", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T19:30:49.000Z", "contentLength": 42326, "httpStatusCode": 200}', '618e6386-1574-4768-8d2d-cd96471985ae', 'c1abf0ae-af48-41dd-bbca-5a6b1f0db0b3', '{}', NULL, false, false),
	('4ec24414-4bf3-4481-9770-ecc83d6cccfd', 'card-audio', '1789761974218_front_e2fe920e.mp3', NULL, '2026-09-18 20:06:14.41108+00', '2026-09-18 20:06:14.41108+00', '2026-09-18 20:06:14.41108+00', '{"eTag": "\"b0b89dc6b873dcecb9bf5c7af3f6852e\"", "size": 24192, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:06:15.000Z", "contentLength": 24192, "httpStatusCode": 200}', 'ce3fda33-bd47-4953-a6b7-f38ac7770428', NULL, '{}', NULL, false, false),
	('e8f64a87-a4a6-4780-bf98-2fd3f90f0846', 'card-audio', '1789761973435_back_0bf3d21e.mp3', NULL, '2026-09-18 20:06:14.808663+00', '2026-09-18 20:06:14.808663+00', '2026-09-18 20:06:14.808663+00', '{"eTag": "\"6d441828ce8b4c809bd872070d1dc9f6\"", "size": 16896, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:06:15.000Z", "contentLength": 16896, "httpStatusCode": 200}', '2a90b86a-79df-4d0c-8e26-26433ed78f24', NULL, '{}', NULL, false, false),
	('fd8d0713-c135-4d32-af21-4d4e65873e3d', 'card-audio', '1789761994540_front_de648f3c.mp3', NULL, '2026-09-18 20:06:34.666924+00', '2026-09-18 20:06:34.666924+00', '2026-09-18 20:06:34.666924+00', '{"eTag": "\"c2eb536908c84660b8676a1515d86c45\"", "size": 16896, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:06:35.000Z", "contentLength": 16896, "httpStatusCode": 200}', '24e1c854-47ef-434b-9576-2a4e5727afa9', NULL, '{}', NULL, false, false),
	('40d1f763-2ec2-4647-957d-912d42b34524', 'card-audio', '1789761994748_back_449e1a12.mp3', NULL, '2026-09-18 20:06:34.863898+00', '2026-09-18 20:06:34.863898+00', '2026-09-18 20:06:34.863898+00', '{"eTag": "\"52af3fe4e70669b297110d841a283145\"", "size": 36864, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:06:35.000Z", "contentLength": 36864, "httpStatusCode": 200}', '6b93af3a-0664-4ade-b834-41f9dc6248a9', NULL, '{}', NULL, false, false),
	('d74fe51f-f7ed-4d2c-bb97-71986b3e6e37', 'card-audio', '1789762010750_back_86f8dc0c.mp3', NULL, '2026-09-18 20:06:50.883315+00', '2026-09-18 20:06:50.883315+00', '2026-09-18 20:06:50.883315+00', '{"eTag": "\"60a114d694b2e898d5fd7c2da7701533\"", "size": 55296, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:06:51.000Z", "contentLength": 55296, "httpStatusCode": 200}', '10837283-6195-4fe9-b7c3-68be4e1f6b36', NULL, '{}', NULL, false, false),
	('93be9f0b-a0db-411f-b046-7ccc6f2e5bff', 'card-audio', '1789762010908_front_c529c4b7.mp3', NULL, '2026-09-18 20:06:51.064691+00', '2026-09-18 20:06:51.064691+00', '2026-09-18 20:06:51.064691+00', '{"eTag": "\"b1c44f4864ae7c41e987b862ded36b6e\"", "size": 41088, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:06:52.000Z", "contentLength": 41088, "httpStatusCode": 200}', 'c05243bd-1dd7-4fb6-b776-24fe476bf1b1', NULL, '{}', NULL, false, false),
	('6fa5a07a-3715-4d37-b496-6e5e56c38392', 'card-audio', '1789762023998_back_e5eb2572.mp3', NULL, '2026-09-18 20:07:04.141687+00', '2026-09-18 20:07:04.141687+00', '2026-09-18 20:07:04.141687+00', '{"eTag": "\"b0c06826c593985b63ecca0825572a32\"", "size": 22656, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:07:05.000Z", "contentLength": 22656, "httpStatusCode": 200}', '96aab8a6-04bb-45a4-8a63-56bafd242850', NULL, '{}', NULL, false, false),
	('c96e83b6-c6e0-438c-9e1e-3cac3138ca41', 'card-audio', '1789762024681_front_f575c7ca.mp3', NULL, '2026-09-18 20:07:04.789514+00', '2026-09-18 20:07:04.789514+00', '2026-09-18 20:07:04.789514+00', '{"eTag": "\"373386d6f2998b1ae0fa682caac7a106\"", "size": 22656, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:07:05.000Z", "contentLength": 22656, "httpStatusCode": 200}', 'a0c96af3-c801-4bd3-9e5c-60935b9b10fc', NULL, '{}', NULL, false, false),
	('6bc57734-fd76-434d-a15a-9d401570b93e', 'card-audio', '1789762036732_back_cf94165d.mp3', NULL, '2026-09-18 20:07:16.871129+00', '2026-09-18 20:07:16.871129+00', '2026-09-18 20:07:16.871129+00', '{"eTag": "\"cb0559f38db56170439165fc6847667a\"", "size": 23424, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:07:17.000Z", "contentLength": 23424, "httpStatusCode": 200}', '5c2ffd25-9044-4ff7-a88b-f8dc6e8f684b', NULL, '{}', NULL, false, false),
	('859d7d90-263a-403a-8048-9e5b5ac26f52', 'card-audio', '1789762036798_front_9a17a8d4.mp3', NULL, '2026-09-18 20:07:16.964901+00', '2026-09-18 20:07:16.964901+00', '2026-09-18 20:07:16.964901+00', '{"eTag": "\"c19c25341037cc5c725419601cce4d2f\"", "size": 11520, "mimetype": "audio/mpeg", "cacheControl": "max-age=3600", "lastModified": "2026-09-18T20:07:17.000Z", "contentLength": 11520, "httpStatusCode": 200}', '81b07902-381f-4c8a-8a62-64a0ddbeddd1', NULL, '{}', NULL, false, false);


--
-- Data for Name: s3_multipart_uploads; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--



--
-- Data for Name: s3_multipart_uploads_parts; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--



--
-- Data for Name: vector_indexes; Type: TABLE DATA; Schema: storage; Owner: supabase_storage_admin
--



--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE SET; Schema: auth; Owner: supabase_auth_admin
--

SELECT pg_catalog.setval('"auth"."refresh_tokens_id_seq"', 27, true);


--
-- PostgreSQL database dump complete
--

-- \unrestrict WjNF07t7UxBHY5L3LPsccrVafIMtSGLtCPNyqGjGSGR1i1iqrlQWDZODnyRV0Cp

RESET ALL;
