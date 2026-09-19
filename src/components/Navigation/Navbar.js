import { useRouter } from 'next/navigation';
import { Cog6ToothIcon } from '@heroicons/react/24/outline';
import './Navbar.css';
import { NAME } from '../../constants/names';
import AnkiModeBadge from './AnkiModeBadge';

// The badge exists to say "this is not the real thing", so it must not appear
// on the real thing. NODE_ENV is 'development' under `next dev` and
// 'production' in any built deployment; NEXT_PUBLIC_APP_ENV lets a preview
// deployment label itself without pretending to be production.
const ENV_BADGE =
  process.env.NEXT_PUBLIC_APP_ENV || (process.env.NODE_ENV === 'production' ? '' : 'Dev');

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
        {ENV_BADGE && (
          <span className="beta-tag" style={{ fontFamily: 'Courier New', fontSize: '0.8rem' }}>
            {' '}{ENV_BADGE}
          </span>
        )}
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
