'use client';

import { RealtimeProvider } from '../../../../../contexts/RealtimeContext';
import VoiceMode from '../../../../../components/Review/VoiceMode';

export default function DeckVoicePage() {
  return (
    <RealtimeProvider>
      <VoiceMode />
    </RealtimeProvider>
  );
}
