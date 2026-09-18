/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Don't let the framework write AGENTS.md/CLAUDE.md into the repo.
  agentRules: false,
  // Migrated from Create React App: the deployment still holds the Supabase
  // credentials under their REACT_APP_* names, so accept either spelling and
  // expose the NEXT_PUBLIC_* one the client code reads.
  env: {
    NEXT_PUBLIC_SUPABASE_URL:
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL || '',
    NEXT_PUBLIC_SUPABASE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_KEY || process.env.REACT_APP_SUPABASE_KEY || '',
    NEXT_PUBLIC_VERCEL_ANALYTICS_ID:
      process.env.NEXT_PUBLIC_VERCEL_ANALYTICS_ID || process.env.REACT_APP_VERCEL_ANALYTICS_ID || '',
  },
};

module.exports = nextConfig;
