'use client';

import Navbar from './Navigation/Navbar';
import { DeckProvider } from '../contexts/DeckContext';
import TemplateUpdate from './Setup/TemplateUpdate';

// A local tool with no account and no review screen (reviewing happens in
// Anki). DeckProvider is the one thing every screen here needs, since it is
// what talks to whichever Anki transport is live.
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
