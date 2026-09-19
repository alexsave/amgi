/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Don't let the framework write AGENTS.md/CLAUDE.md into the repo.
  agentRules: false,
  // plusaudio (see pnpm-workspace.yaml's comment on why it is a workspace
  // member at all) touches node:sqlite and the filesystem to read a closed
  // Anki collection directly - real Node built-ins, not something to trace
  // through and bundle. This is what tells Next to require() it natively at
  // runtime, from whichever route handler under src/server/anki/ asks for
  // it, instead of bundling it into the server function. Nothing under
  // plusaudio is ever reachable from client code regardless of this list -
  // that boundary is the route-handler-only import rule described in
  // src/server/anki/transport.js's own module comment, not this option.
  //
  // This only actually works under webpack today - Turbopack (Next 16's
  // default bundler) still fails to resolve node:sqlite through this same
  // externalized package with "Unsupported external type Url for commonjs
  // reference" (a known class of Turbopack gap for native/Node-only deps as
  // of Next 16.3, see vercel/next.js#86099 for the same failure mode against
  // a different package). That is why package.json's dev/build scripts pass
  // `--webpack` - not a style choice, a workaround for this specific bug.
  serverExternalPackages: ['plusaudio'],
  // Migrated from Create React App: the deployment still holds this under
  // its REACT_APP_* name, so accept either spelling and expose the
  // NEXT_PUBLIC_* one the client code reads. amgi has no backend account of
  // its own any more (no Supabase project, no login) - this is just
  // anonymous web-vitals reporting.
  env: {
    NEXT_PUBLIC_VERCEL_ANALYTICS_ID:
      process.env.NEXT_PUBLIC_VERCEL_ANALYTICS_ID || process.env.REACT_APP_VERCEL_ANALYTICS_ID || '',
  },
};

module.exports = nextConfig;
