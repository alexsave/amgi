'use client';

import Navbar from './Navigation/Navbar';
import { DeckProvider } from '../contexts/DeckContext';
import TemplateUpdate from './Setup/TemplateUpdate';

// A local tool, not a signed-in web app any more: no ProtectedRoute (there is
// no account to be protected from), no CardGenerationProvider/AudioProvider
// (Supabase-backed AI card generation and review audio playback - gone with
// the review surface itself, which now lives in Anki). DeckProvider is the
// one thing every screen here needs, since it is what talks to whichever
// Anki transport is live.
export default function AppShell({ children }) {
  return (
    <DeckProvider>
      <div className="App">
        <div className="app-container">
          <Navbar />
          <div className="app-content">
            <TemplateUpdate />
            {children}
          </div>
        </div>
      </div>
    </DeckProvider>
  );
}
