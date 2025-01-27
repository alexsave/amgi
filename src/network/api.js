// Network API operations

const API_BASE_URL = process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : '';

export const getRealtimeToken = async () => {
  console.log('Requesting realtime token...');
  const response = await fetch(`${API_BASE_URL}/api/realtime-token`);
  if (!response.ok) {
    const error = `Failed to get token: ${response.statusText}`;
    console.error(error);
    throw new Error(error);
  }
  const data = await response.json();
  console.log('Got token response:', data);
  if (!data.client_secret?.value) {
    const error = 'Invalid token response';
    console.error(error, data);
    throw new Error(error);
  }
  console.log('Successfully extracted token');
  return data.client_secret.value;
};

export const generateCard = async (userInput, targetLang, onProgress) => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/generate_cards`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userInput,
        targetLang,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to generate card');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let card = null;
    let audioReady = { front: false, back: false };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n').filter(line => line.trim());

      for (const line of lines) {
        const data = JSON.parse(line);
        
        if (data.type === 'card') {
          card = data.data;
          onProgress({ type: 'text', data: card });
        } else if (data.type === 'audio') {
          const audioData = new Uint8Array(data.data);
          const blob = new Blob([audioData], { type: 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          
          audioReady[data.side] = true;
          onProgress({ type: 'audio', side: data.side, url });
        }
      }
    }

    return { card, audioReady };
  } catch (err) {
    console.error('Error in generateCard:', err);
    throw err;
  }
};

export const evaluateSpeech = async (audioBlob, expectedText, sourceLang, expectedAudioBlob) => {
  try {
    const [userAudioBase64, expectedAudioBase64] = await Promise.all([
      blobToBase64(audioBlob),
      blobToBase64(expectedAudioBlob)
    ]);

    const response = await fetch(`${API_BASE_URL}/api/evaluate_speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audioBase64: userAudioBase64,
        expectedText,
        sourceLang,
        expectedAudioBase64,
        audioFormat: 'mp3'
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error('Failed to evaluate speech: ' + (errorData.error || 'Unknown error'));
    }

    return await response.json();
  } catch (err) {
    console.error('Error evaluating speech:', err);
    throw err;
  }
};

const blobToBase64 = (blob) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}; 