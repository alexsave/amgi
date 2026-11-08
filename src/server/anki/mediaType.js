// The Content-Type a clip is served with, by extension. A deck can hold both
// kinds amgi has ever made - mp3 from before speech moved to Gemini, wav
// since (see plusaudio/lib/audio-store.js) - plus whatever a shared deck's
// author recorded, and the browser's <audio> needs the right type for each.

const TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

export function contentTypeFor(name) {
  const lower = String(name || '').toLowerCase();
  const dot = lower.lastIndexOf('.');
  return (dot >= 0 && TYPES[lower.slice(dot)]) || 'application/octet-stream';
}
