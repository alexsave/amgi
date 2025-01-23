// Audio utility functions
import vmsg from "vmsg";

export const recorder = new vmsg.Recorder({
  wasmURL: "https://unpkg.com/vmsg@0.3.0/vmsg.wasm"
});

export const initializeRecording = async () => {
  try {
    await recorder.initAudio();
    await recorder.initWorker();
    return true;
  } catch (e) {
    console.error('Error initializing recording:', e);
    throw new Error('Failed to initialize recording: ' + e.message);
  }
};

export const startRecording = () => {
  try {
    recorder.startRecording();
    return true;
  } catch (e) {
    console.error('Error starting recording:', e);
    throw new Error('Failed to start recording: ' + e.message);
  }
};

export const stopRecording = async () => {
  try {
    const audioBlob = await recorder.stopRecording();
    if (audioBlob.size === 0) {
      throw new Error('No audio data recorded');
    }
    return audioBlob;
  } catch (e) {
    console.error('Error stopping recording:', e);
    throw new Error('Failed to stop recording: ' + e.message);
  }
};

export const createAudioPlayer = () => {
  const audio = new Audio();
  let currentBlobUrl = null;

  return {
    audio,
    play: async (blobUrl) => {
      try {
        // Clean up old blob URL
        if (currentBlobUrl) {
          URL.revokeObjectURL(currentBlobUrl);
        }
        
        // Stop any currently playing audio
        audio.pause();
        audio.currentTime = 0;

        // Set and play new audio
        audio.src = blobUrl;
        currentBlobUrl = blobUrl;
        await audio.play();
      } catch (err) {
        console.error('Error playing audio:', err);
        throw new Error('Failed to play audio: ' + err.message);
      }
    },
    cleanup: () => {
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
      audio.pause();
      audio.src = '';
    }
  };
}; 