---
name: e2e-ui
description: Run amgi locally against a seeded local Supabase and drive it in headless Chrome - screenshot any screen as a signed-in user, measure layout, or exercise the hands-free review loop with a synthetic microphone. Use when asked to check how something looks, prove a UI change works in the real app, hunt for visual weirdness, or debug review/voice behaviour.
---

# Driving amgi end to end

Everything here runs against a **local** Supabase stack with seeded data.
Never point the app at the production project, and never create data in it.

## One-time setup

```bash
cd /Users/alex/Dev/amgi
pnpm add -D puppeteer-core        # only if node -e "require('puppeteer-core')" fails
supabase start                    # Docker; applies supabase/migrations
mkdir -p .e2e && supabase status -o env > .e2e/local-supa.env
node .claude/skills/e2e-ui/scripts/seed.js
```

`supabase status -o env` writes the local URL and keys to `.e2e/local-supa.env`, which is gitignored.
Read those values with shell substitution rather than printing them.

`seed.js` creates `test@amgi.cards` / `password` - the exact account the welcome page's "Try Test Account" button signs in as, so every driver script logs in with one click.
It also creates a "Korean Phrases" deck whose 10 cards have real audio, generated with macOS `say` and uploaded through the anon client so RLS is exercised rather than bypassed.

## Running the app against it

```bash
cd /Users/alex/Dev/amgi
export NEXT_PUBLIC_SUPABASE_URL=$(grep '^API_URL' .e2e/local-supa.env | cut -d= -f2- | tr -d '"')
export NEXT_PUBLIC_SUPABASE_KEY=$(grep '^ANON_KEY' .e2e/local-supa.env | cut -d= -f2- | tr -d '"')
npx next dev -p 3111
```

Inline env vars beat `.env.local`, so this does not disturb the production credentials sitting in that file.
Check it is up with `curl -s -o /dev/null -w "%{http_code}" http://localhost:3111/`.

## Driving it

```bash
# Screenshot routes as the signed-in test user, at any viewport
node .claude/skills/e2e-ui/scripts/shoot.js /decks /settings
VIEWPORT=390x844 OUT=.e2e/shots-mobile node .claude/skills/e2e-ui/scripts/shoot.js /decks

# One full card through the review loop, with phase timings
node .claude/skills/e2e-ui/scripts/review-flow.js
```

Both scripts print console errors, page errors and failed requests at the end.
That output is usually where the real bugs are, so read it even when the screenshots look fine.

**Always open the PNGs with the Read tool.** Layout defects do not show up in the DOM.
When judging alignment, also measure: `page.evaluate(() => el.getBoundingClientRect())` and compare against `window.innerWidth/innerHeight`, then state the numbers.

## The microphone

Chrome's `--use-file-for-fake-audio-capture` is a **no-op on this machine** - the captured stream is digital silence, which makes the review loop look broken when it is not (it waits out the 8s no-speech timeout).
Do not spend time regenerating wav files; it is not a format problem.

Instead `scripts/fakevoice.js` overrides `navigator.mediaDevices.getUserMedia` with a synthetic stream: silence, then a noise-shaped tone loud enough to read as speech, then silence.

```js
await page.evaluateOnNewDocument(fakeVoiceScript({ leadMs: 500, speechMs: 1500 }));
```

The app's own audio path still runs, so this exercises the real detector.
Expect the turn to end about `leadMs + speechMs + 1200ms` after the mic opens; 1200ms is the silence `detectSpeechEnd` waits for.
Chrome's default fake device (no file flag) produces a periodic beep and is fine for checking that a visualizer animates, but not for voice-activity timing.

## Gotchas worth remembering

- The review screen needs a user gesture before it does anything: click `.review-gate .primary-btn`. That one click is both the mic consent and the autoplay unlock.
- Clicking a deck row goes straight to review, not to the card list. Navigate to `/deck/<id>` directly for the card list.
- `next dev` occasionally dies between runs. Re-check the port before blaming the app.
- Consent checkboxes in signup are visually hidden, so `elementHandle.click()` fails with "Node is either not clickable". Use `page.$$eval('input[type=checkbox]', els => els.forEach(e => e.click()))`.
- Signing up against the production project fails with "email rate limit exceeded" (Supabase's default SMTP allows 2/hour). Another reason to stay local.
