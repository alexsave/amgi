// Injects a synthetic microphone: getUserMedia returns a stream that is
// silent for `leadMs`, then noise-shaped "speech" for `speechMs`, then
// silence. Deterministic, and it exercises the app's real audio path
// (Chrome's --use-file-for-fake-audio-capture is a no-op on this machine).
module.exports = function fakeVoiceScript({ leadMs = 600, speechMs = 1500, totalMs = 12000 } = {}) {
  return `(() => {
    const leadMs = ${leadMs}, speechMs = ${speechMs}, totalMs = ${totalMs};
    const makeStream = () => {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const rate = ctx.sampleRate;
      const buffer = ctx.createBuffer(1, Math.ceil((totalMs / 1000) * rate), rate);
      const data = buffer.getChannelData(0);
      const start = Math.floor((leadMs / 1000) * rate);
      const end = start + Math.floor((speechMs / 1000) * rate);
      for (let i = start; i < end && i < data.length; i++) {
        // A wobbling tone plus noise: loud enough and irregular enough to
        // look like a voice to an RMS-based detector.
        const t = (i - start) / rate;
        const env = Math.min(1, t * 8) * Math.min(1, (speechMs / 1000 - t) * 8);
        data[i] = env * (0.45 * Math.sin(2 * Math.PI * 180 * t) + 0.15 * (Math.random() * 2 - 1));
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = false;
      const dest = ctx.createMediaStreamDestination();
      source.connect(dest);
      source.start();
      window.__fakeVoiceStartedAt = Date.now();
      return dest.stream;
    };
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints && constraints.audio) return makeStream();
      return original(constraints);
    };
  })();`;
};
