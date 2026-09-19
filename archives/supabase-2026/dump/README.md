# Snapshot of the hosted Supabase project, 2026-09-19

Taken from project `gcdjmhziyfwsnaloxulp` (amgi-v2) with `supabase db dump` on the day the backend was retired, so that nothing in the hosted database is lost if the project is later paused or deleted.

- `schema.sql` - the full schema, including the tables the app used (`decks`, `cards`, `reviews`, `review_logs`, `user_preferences`, the subscription tables) and their RLS policies.
- `data.sql` - the rows that existed at that moment. This is test and demo data: the `test@amgi.cards` demo account's deck, the cards generated while verifying the app, and the subscription tiers. There is no real user data in here.

What is NOT in this dump: the contents of the `card-audio` storage bucket, which held the generated mp3 and wav clips.
Those were never worth preserving - every clip is reproducible from the card text, and the generator now writes them locally.

The migrations that produced this schema are in the parent directory, and they remain the readable source of truth.
The dump is here for the rows and for the exact state of things like the storage policies.

## The hosted project itself

Still exists and was not deleted, because deleting a Supabase project is irreversible and there was no reason to rush it.
It still contains the `test@amgi.cards` demo account created for the welcome screen's "Try Test Account" button, and roughly 16 orphaned audio objects whose cards were deleted.
Pausing or deleting it is safe once you are happy with this snapshot.
