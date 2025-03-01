/**
 * Language definitions for the application
 * Each language has a code, name, and flag emoji
 */
export const LANGUAGES = {
  en: { name: 'English', flag: '🇺🇸' },
  zh_cn: { name: '中文', flag: '🇨🇳' }, // Mandarin 
  es: { name: 'Español', flag: '🇪🇸' },
  fr: { name: 'Français', flag: '🇫🇷' },
  pt: { name: 'Português', flag: '🇵🇹' },
  ru: { name: 'Русский', flag: '🇷🇺' },
  id: { name: 'Bahasa Indonesia', flag: '🇮🇩' },
  de: { name: 'Deutsch', flag: '🇩🇪' },
  ja: { name: '日本語', flag: '🇯🇵' },
  tr: { name: 'Türkçe', flag: '🇹🇷' },
  zh_hk: { name: '廣東話', flag: '🇭🇰' }, // Cantonese
  vi: { name: 'Tiếng Việt', flag: '🇻🇳' },
  ko: { name: '한국어', flag: '🇰🇷' },
  it: { name: 'Italiano', flag: '🇮🇹' },
  th: { name: 'ภาษาไทย', flag: '🇹🇭' },
};

// Helper function to get language display info
export const getLanguageDisplay = (langCode) => {
  return LANGUAGES[langCode] || { name: langCode, flag: '🌍' };
};

export default LANGUAGES;
