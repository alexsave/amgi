import React, { useEffect, useState } from 'react';
import { ankiApi } from '../../utils/ankiApi';
import { loadAnkiSettings, saveAnkiSettings } from '../../utils/ankiSettings';
import { useDecks } from '../../contexts/DeckContext';
import AnkiModeBadge from '../Navigation/AnkiModeBadge';

/**
 * Profile and bridge selection for the local Anki transport - see
 * src/server/anki/transport.js for how these choices turn into "which
 * transport is live". Kept entirely in this browser's localStorage (see
 * ankiSettings.js), since there is no account for any of this.
 */
const AnkiSetupPanel = () => {
  const { refreshAnkiDecks } = useDecks();
  const [settings, setSettings] = useState(loadAnkiSettings());
  const [scan, setScan] = useState({ loading: false, baseDir: '', baseDirExists: null, profiles: [], error: '' });
  const [saved, setSaved] = useState(false);
  const [install, setInstall] = useState({ running: false, message: '', ok: null });

  const scanForProfiles = async (baseDirOverride) => {
    setScan(prev => ({ ...prev, loading: true, error: '' }));
    // Scan with whatever override is currently typed, without waiting for a
    // save first - so trying a folder is a preview, not a commitment.
    const probeSettings = { ...settings, baseDirOverride };
    saveAnkiSettingsQuietly(probeSettings);
    try {
      const result = await ankiApi.profiles();
      setScan({ loading: false, baseDir: result.baseDir, baseDirExists: result.baseDirExists, profiles: result.profiles, error: '' });
    } catch (err) {
      setScan(prev => ({ ...prev, loading: false, error: err.message }));
    } finally {
      // Restore the real saved settings underneath the scan - only "Save"
      // below should actually commit a choice.
      saveAnkiSettingsQuietly(settings);
    }
  };

  // A version of saveAnkiSettings that doesn't fire the change event other
  // components listen for - used for the scan-preview round trip above so
  // browsing profiles doesn't flicker the mode badge before Save is pressed.
  const saveAnkiSettingsQuietly = (next) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('amgi:anki-settings', JSON.stringify(next));
    }
  };

  useEffect(() => {
    scanForProfiles(settings.baseDirOverride);
    // Only on mount - re-scanning on every keystroke of baseDirOverride
    // would spam the profiles endpoint; the "Scan" button re-runs it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = () => {
    saveAnkiSettings(settings);
    setSaved(true);
    refreshAnkiDecks();
    setTimeout(() => setSaved(false), 2000);
  };

  // Copies both add-ons and the card type into Anki's data folder. Everything
  // that needs Anki's own API - creating the note type, writing its media into
  // the collection - happens inside the add-on on the next profile open, which
  // is why the only thing to report here is "restart Anki".
  const runInstall = async () => {
    setInstall({ running: true, message: '', ok: null });
    try {
      const result = await ankiApi.install(settings.baseDirOverride);
      setInstall({ running: false, message: `${result.message} (${result.addonsDir})`, ok: true });
    } catch (error) {
      setInstall({ running: false, message: error.message, ok: false });
    }
  };

  const pickProfile = (profile) => {
    setSettings(prev => ({ ...prev, collectionPath: profile.collectionPath, profileName: profile.name }));
  };

  return (
    <div className="preferences-section">
      <div className="preference-item" style={{ alignItems: 'center' }}>
        <label>Current mode</label>
        <AnkiModeBadge />
      </div>

      <div className="preference-item install-block">
        <label>Install amgi into Anki</label>
        <p className="preference-help">
          Adds amgi&rsquo;s microphone and bridge add-ons, and the &ldquo;amgi Listening&rdquo; note type, to the
          Anki on this machine. Safe to run again to update them.
        </p>
        <p className="preference-help">
          Installs into{' '}
          <code>{settings.baseDirOverride || 'your default Anki data folder'}</code>
          {settings.baseDirOverride ? '' : ' - set the override below to install somewhere else.'}
        </p>
        <button type="button" className="save-button" onClick={runInstall} disabled={install.running}>
          {install.running ? 'Installing…' : 'Install into Anki'}
        </button>
        {install.message && (
          <div className={install.ok ? 'message success' : 'message error'}>{install.message}</div>
        )}
      </div>

      <div className="preference-item">
        <label htmlFor="ankiBaseDir">Anki data folder (optional override)</label>
        <input
          id="ankiBaseDir"
          type="text"
          value={settings.baseDirOverride}
          onChange={(e) => setSettings(prev => ({ ...prev, baseDirOverride: e.target.value }))}
          placeholder="Leave blank to use the default Anki2 folder for this OS"
        />
      </div>
      <div className="preference-item">
        <button type="button" className="save-button" onClick={() => scanForProfiles(settings.baseDirOverride)} disabled={scan.loading}>
          {scan.loading ? 'Scanning…' : 'Scan for profiles'}
        </button>
      </div>

      {scan.error && <div className="message error">{scan.error}</div>}

      {!scan.loading && scan.baseDirExists === false && (
        <div className="message error">
          No Anki data folder was found at <code>{scan.baseDir}</code>. If Anki is not installed yet, install it
          and open it once to create a profile, then scan again.
        </div>
      )}

      {!scan.loading && scan.baseDirExists && scan.profiles.length === 0 && (
        <div className="message error">
          Found the Anki data folder but no profile with a collection in it yet - open Anki once to create one.
        </div>
      )}

      {scan.profiles.length > 0 && (
        <div className="preference-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '0.4rem' }}>
          <label>Profile</label>
          {scan.profiles.map((profile) => (
            <label key={profile.collectionPath} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 400 }}>
              <input
                type="radio"
                name="ankiProfile"
                checked={settings.collectionPath === profile.collectionPath}
                onChange={() => pickProfile(profile)}
              />
              {profile.name}
            </label>
          ))}
        </div>
      )}

      <div className="preference-item checkbox">
        <label htmlFor="bridgeEnabled">Use the Anki bridge (when Anki is open)</label>
        <input
          id="bridgeEnabled"
          type="checkbox"
          checked={settings.bridge.enabled}
          onChange={(e) => setSettings(prev => ({ ...prev, bridge: { ...prev.bridge, enabled: e.target.checked } }))}
        />
      </div>
      {settings.bridge.enabled && (
        <>
          <div className="preference-item">
            <label htmlFor="bridgeUrl">Bridge address</label>
            <input
              id="bridgeUrl"
              type="text"
              value={settings.bridge.baseUrl}
              onChange={(e) => setSettings(prev => ({ ...prev, bridge: { ...prev.bridge, baseUrl: e.target.value } }))}
              placeholder="http://127.0.0.1:8798"
            />
          </div>
          <div className="preference-item">
            <label htmlFor="bridgeToken">Bridge token</label>
            <input
              id="bridgeToken"
              type="text"
              value={settings.bridge.token}
              onChange={(e) => setSettings(prev => ({ ...prev, bridge: { ...prev.bridge, token: e.target.value } }))}
              placeholder="From Anki's Tools > amgi: Bridge status…"
            />
          </div>
        </>
      )}

      {saved && <div className="message success">Anki settings saved.</div>}

      <div className="preference-item">
        <button type="button" className="save-button" onClick={handleSave}>Save Anki settings</button>
      </div>
    </div>
  );
};

export default AnkiSetupPanel;
