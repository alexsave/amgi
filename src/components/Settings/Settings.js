import React from 'react';
import { useRouter } from 'next/navigation';
import AnkiSetupPanel from './AnkiSetupPanel';
import './Settings.css';

// No account any more, so no cloud preferences to load or save - the only
// thing left to configure here is which Anki collection amgi talks to.
const Settings = () => {
  const router = useRouter();

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="back-button" onClick={() => router.back()}>
          ← Back
        </button>
        <h2>Settings</h2>
      </div>

      <div className="settings-content">
        <h3>Anki (local)</h3>
        <AnkiSetupPanel />
      </div>
    </div>
  );
};

export default Settings;
