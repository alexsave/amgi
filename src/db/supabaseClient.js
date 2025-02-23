import { createClient } from '@supabase/supabase-js';

class SupabaseClient {
  constructor() {
    if (SupabaseClient.instance) {
      return SupabaseClient.instance;
    }

    this.client = createClient(
      process.env.REACT_APP_SUPABASE_URL,
      process.env.REACT_APP_SUPABASE_KEY
    );

    SupabaseClient.instance = this;
  }

  getClient() {
    return this.client;
  }
}

// Create and export a singleton instance
const supabaseClient = new SupabaseClient();
export default supabaseClient.getClient(); 