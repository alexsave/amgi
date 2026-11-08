import { useRouter } from 'next/navigation';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import './Navbar.css';
import { NAME } from '../../constants/names';
import AnkiModeBadge from './AnkiModeBadge';

// No account, so no sign-out - the mode badge (which Anki transport, if any,
// is live) is the one piece of state worth a permanent home in the navbar.
export default function Navbar() {
  const router = useRouter();

  const goToSettings = () => {
    router.push('/settings');
  };

  return (
    <nav className="navbar">
      <div className="navbar-brand">
        {NAME}
      </div>
      <div className="navbar-actions">
        <AnkiModeBadge />
        <button
          className="navbar-button action-btn settings-icon"
          onClick={goToSettings}
          title="Settings"
        >
          <Cog6ToothIcon />
        </button>
      </div>
    </nav>
  );
}
