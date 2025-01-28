export const blobToBase64 = (blob) => {
  console.log('Converting blob to base64:', {
    size: blob.size,
    type: blob.type
  });
  
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      console.log('Base64 conversion complete:', {
        inputSize: blob.size,
        outputLength: base64.length,
        prefix: base64.substring(0, 50) + '...'
      });
      resolve(base64);
    };
    reader.onerror = (error) => {
      console.error('Error converting blob to base64:', error);
      reject(error);
    };
    reader.readAsDataURL(blob);
  });
}; 