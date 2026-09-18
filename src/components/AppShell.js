'use client';

import ProtectedRoute from './Auth/ProtectedRoute';
import Navbar from './Navigation/Navbar';
import { DeckProvider } from '../contexts/DeckContext';
import { CardGenerationProvider } from '../contexts/CardGenerationContext';
import { AudioProvider } from '../contexts/useAudio';
import { ReviewProvider } from '../contexts/ReviewContext';

// The signed-in app is browser-only: audio recording, playback and the
// Supabase session all live in the client, so this shell is mounted with
// SSR disabled rather than pretending to render on the server.
export default function AppShell({ children }) {
  return (
    <ProtectedRoute>
      <DeckProvider>
        <CardGenerationProvider>
          <div className="App">
            <div className="app-container">
              <Navbar />
              <div className="app-content">
                <AudioProvider>
                  <ReviewProvider>{children}</ReviewProvider>
                </AudioProvider>
              </div>
            </div>
          </div>
        </CardGenerationProvider>
      </DeckProvider>
    </ProtectedRoute>
  );
}
