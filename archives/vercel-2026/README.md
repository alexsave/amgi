# Vercel hosting, retired 2026-09-19

amgi was deployed on Vercel while it was a hosted web app.
It is now a local-first tool: it reads and writes the Anki collection on the machine it runs on, so a build running in someone else's datacentre has nothing to talk to.

`vercel.json` is kept here for reference.
It is the config that told Vercel this was a Next.js project, after the framework preset was still set to Create React App and builds kept failing on a missing `build/` directory.

## What was done to the hosted project

The GitHub integration was disconnected (`vercel git disconnect`), so pushing to `main` no longer creates a deployment.
The project itself was left in place under the `alexsaves-projects` account, along with its last successful deployment, rather than deleted.
Deleting it would free the `amgi-alexsaves-projects.vercel.app` hostname for anyone to claim, and it costs nothing to leave.

## If you ever want it back

Move `vercel.json` back to the repository root, reconnect the GitHub integration in the Vercel dashboard, and push.
Note that a deployed build cannot reach a local Anki collection, so this only makes sense if amgi grows a hosted mode again.
