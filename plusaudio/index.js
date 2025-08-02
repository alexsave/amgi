// Parse .apkg file using Node.js (read-only, no file saving)
const fs = require('fs');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

const file = 'Korean Vocabulary by Evita.apkg';

// Parse command line arguments
const args = process.argv.slice(2);
const targetLang = args.find(arg => arg.startsWith('--target='))?.split('=')[1];
const knownLang = args.find(arg => arg.startsWith('--known='))?.split('=')[1];
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
    console.log(`
Audio Generation for Anki Decks

Usage: node index.js [options]

Options:
  --target=<language>    Hint for the target language (e.g., Spanish, Korean, French)
  --known=<language>     Hint for the known language (e.g., English, Spanish)
  --help, -h            Show this help message

Examples:
  node index.js                              # Auto-detect both languages
  node index.js --target=Spanish            # Hint that target language is Spanish
  node index.js --target=Korean --known=English  # Hint both languages
  node index.js --target=French --known=Spanish  # French-Spanish deck

Note: Language hints help ChatGPT identify the correct fields but are not required.
`);
    process.exit(0);
}

console.log('=== ANKI DECK AUDIO GENERATOR ===');
console.log(`Processing file: ${file}`);
console.log('Command line arguments:');
console.log(`  Target language: ${targetLang || 'auto-detect'}`);
console.log(`  Known language: ${knownLang || 'auto-detect'}`);
console.log('');

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY
});

// Audio validation tools for checking generated audio
const audioValidationTools = [{
    "type": "function",
    "function": {
        "name": "validate_audio",
        "description": "Validate if the audio contains valid speech matching the expected text",
        "parameters": {
            "type": "object",
            "properties": {
                "is_valid": {
                    "type": "boolean",
                    "description": "Whether the audio contains valid speech matching the expected text"
                },
                "transcription": {
                    "type": "string",
                    "description": "The transcribed text from the audio"
                }
            },
            "required": ["is_valid", "transcription"]
        }
    }
}];

// Field detection tools for analyzing note structure
const fieldDetectionTools = [{
    "type": "function",
    "function": {
        "name": "detect_field_languages",
        "description": "Analyze the fields to detect which languages are present and their positions. Use any provided language hints to guide the analysis.",
        "parameters": {
            "type": "object",
            "properties": {
                "targetLangIndex": {
                    "type": "integer",
                    "description": "The index of the field containing the target/foreign language"
                },
                "targetLanguage": {
                    "type": "string",
                    "description": "The name of the target language"
                },
                "knownLangIndex": {
                    "type": "integer",
                    "description": "The index of the field containing the known language"
                },
                "knownLanguage": {
                    "type": "string",
                    "description": "The name of the known language"
                },
                "analysis": {
                    "type": "string",
                    "description": "Brief explanation of the language detection analysis"
                }
            },
            "required": ["targetLangIndex", "targetLanguage", "knownLangIndex", "knownLanguage", "analysis"]
        }
    }
}];

/**
 * Validates an existing audio buffer by transcribing it and checking if it matches expected text
 */
async function validateAudioBuffer(audioBuffer, expectedText, language = 'ko') {
    try {
        // Convert audio buffer to base64 for validation
        const audioBase64 = audioBuffer.toString('base64');

        // Validate with transcription using OpenAI
        console.log(`🔍 Validating audio for "${expectedText}" in ${language}`);
        const validationResponse = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "mp3" },
            messages: [
                {
                    role: "system",
                    content: "You are an audio validation assistant. Listen to the audio and determine if it contains valid speech that matches or is similar to the expected text."
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Validate if this audio contains valid speech that matches the expected text: "${expectedText}" in language: ${language}`
                        },
                        {
                            type: "input_audio",
                            input_audio: { data: audioBase64, format: "mp3" }
                        }
                    ]
                }
            ],
            tools: audioValidationTools,
            tool_choice: { type: "function", function: { name: "validate_audio" } }
        });

        const toolCall = validationResponse.choices[0].message.tool_calls?.[0];

        if (!toolCall) {
            console.error('❌ No tool call in validation response');
            return { isValid: false, transcription: '', error: 'No validation response' };
        }

        const validationResult = JSON.parse(toolCall.function.arguments);
        console.log('🎯 Audio validation result:', validationResult);

        return {
            isValid: validationResult.is_valid && validationResult.transcription.trim().length > 0,
            transcription: validationResult.transcription,
            error: null
        };
    } catch (error) {
        console.error('❌ Audio validation failed:', error);
        return { isValid: false, transcription: '', error: error.message };
    }
}

/**
 * Validates generated audio by transcribing it and checking if it matches expected text
 */
async function validateAndGenerateAudio(text, language = 'ko', maxAttempts = 3) {
    return validateAndGenerateAudioWithVoice(text, language, 'alloy', maxAttempts);
}

/**
 * Validates generated audio with specific voice by transcribing it and checking if it matches expected text
 */
async function validateAndGenerateAudioWithVoice(text, language = 'ko', voice = 'alloy', maxAttempts = 3) {
    let audioBuffer = null;
    let isValidAudio = false;
    let attempts = 0;

    while (!isValidAudio && attempts < maxAttempts) {
        attempts++;
        console.log(`Audio generation attempt ${attempts}/${maxAttempts} for text: "${text}"`);

        try {
            // Generate audio using OpenAI TTS
            const audioResponse = await openai.audio.speech.create({
                //model: "tts-1", // Use tts-1 for Node.js (tts-1-hd for higher quality)
                model: "gpt-4o-mini-tts",
                voice: "alloy",
                input: text,
                response_format: "mp3"
            });

            const tempBuffer = Buffer.from(await audioResponse.arrayBuffer());
            console.log('Audio buffer size:', tempBuffer.byteLength);

            // Convert to base64 for validation
            const audioBase64 = tempBuffer.toString('base64');

            // Validate with transcription using OpenAI
            console.log(`Validating audio for "${text}" in ${language}`);
            const validationResponse = await openai.chat.completions.create({
                model: "gpt-4o-audio-preview",
                modalities: ["text", "audio"],
                audio: { voice: "alloy", format: "mp3" },
                messages: [
                    {
                        role: "system",
                        content: "You are an audio validation assistant. Listen to the audio and determine if it contains valid speech that matches or is similar to the expected text."
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "text",
                                text: `Validate if this audio contains valid speech that matches the expected text: "${text}" in language: ${language}`
                            },
                            {
                                type: "input_audio",
                                input_audio: { data: audioBase64, format: "mp3" }
                            }
                        ]
                    }
                ],
                tools: audioValidationTools,
                tool_choice: { type: "function", function: { name: "validate_audio" } }
            });

            const toolCall = validationResponse.choices[0].message.tool_calls?.[0];

            if (!toolCall) {
                console.error('No tool call in validation response');
                continue;
            }

            const validationResult = JSON.parse(toolCall.function.arguments);
            console.log('Audio validation result:', validationResult);

            // Check validity
            if (validationResult.is_valid && validationResult.transcription.trim().length > 0) {
                isValidAudio = true;
                audioBuffer = tempBuffer;
                console.log('Audio validation successful - transcription:', validationResult.transcription);
            } else {
                console.log('Audio validation failed - transcription:', validationResult.transcription);
            }
        } catch (audioError) {
            console.error(`Audio generation attempt ${attempts} failed:`, audioError);
        }
    }

    if (!isValidAudio || !audioBuffer) {
        throw new Error(`Failed to generate valid audio for "${text}" after ${attempts} attempts`);
    }

    return audioBuffer;
}

/**
 * Analyze a sample note to detect which field contains which language
 */
async function detectFieldLanguages(sampleNote, expectedTargetLang = null, expectedKnownLang = null) {
    console.log('Analyzing note structure to detect field languages...');
    const fields = sampleNote.flds.split('\x1f');
    
    console.log(`Sample note has ${fields.length} fields:`);
    fields.forEach((field, index) => {
        console.log(`  Field ${index}: "${field}"`);
    });

    // Build the prompt based on whether language hints are provided
    let userPrompt = `Analyze this flashcard note and identify the languages in each field:

Fields (separated by \\x1f):
${fields.map((field, index) => `Field ${index}: "${field}"`).join('\n')}

Determine:
1. Which field contains the target/foreign language (the language being learned)
2. Which field contains the known language (typically English or the native language)
3. What languages they are`;

    // Add language hints if provided
    if (expectedTargetLang || expectedKnownLang) {
        userPrompt += `

LANGUAGE HINTS PROVIDED:`;
        if (expectedTargetLang) {
            userPrompt += `
- Expected target language: ${expectedTargetLang}`;
        }
        if (expectedKnownLang) {
            userPrompt += `
- Expected known language: ${expectedKnownLang}`;
        }
        userPrompt += `

Use these hints to help identify the correct fields. The hints should guide your analysis, but still examine the actual content to confirm.`;
    }

    userPrompt += `

Consider:
- Script types (Latin, Hangul, Kanji, Cyrillic, etc.)
- Character patterns
- Language-specific features
- Context clues`;

    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: "You are a language detection expert. Analyze the provided flashcard fields to identify which field contains which language. Look for patterns in text, scripts, and characters to determine the languages present."
                },
                {
                    role: "user",
                    content: userPrompt
                }
            ],
            tools: fieldDetectionTools,
            tool_choice: { type: "function", function: { name: "detect_field_languages" } }
        });

        const toolCall = response.choices[0].message.tool_calls?.[0];
        if (!toolCall) {
            throw new Error('No tool call in field detection response');
        }

        const detectionResult = JSON.parse(toolCall.function.arguments);
        console.log('Field detection result:', detectionResult);
        
        return detectionResult;
    } catch (error) {
        console.error('Error detecting field languages:', error);
        throw error;
    }
}

/**
 * Generate audio for target language text and save to file
 */
async function generateTargetLanguageAudio(text, index, language) {
    try {
        console.log(`Generating audio for: "${text}" (${language})`);
        const languageCode = getLanguageCode(language);
        const audioBuffer = await validateAndGenerateAudio(text, languageCode);
        
        // Save audio file
        const filename = `${language.toLowerCase()}_audio_${index + 1}.mp3`;
        fs.writeFileSync(filename, audioBuffer);
        console.log(`Audio saved as: ${filename}`);
        
        return filename;
    } catch (error) {
        console.error(`Failed to generate audio for "${text}" (${language}):`, error);
        return null;
    }
}

/**
 * Get ISO language code from language name
 */
function getLanguageCode(languageName) {
    const languageMap = {
        'korean': 'ko',
        'spanish': 'es',
        'french': 'fr',
        'german': 'de',
        'italian': 'it',
        'portuguese': 'pt',
        'japanese': 'ja',
        'chinese': 'zh',
        'russian': 'ru',
        'arabic': 'ar',
        'dutch': 'nl',
        'english': 'en'
    };
    
    const normalized = languageName.toLowerCase();
    return languageMap[normalized] || 'en'; // Default to English if not found
}

/**
 * Analyze review progress and audio status of the deck
 */
async function analyzeDeckProgress(db) {
    console.log('\n=== DECK ANALYSIS ===');
    
    // Get total note count
    const totalNotes = db.prepare("SELECT COUNT(*) as count FROM notes").get();
    console.log(`Total notes in deck: ${totalNotes.count}`);
    
    // Get card statistics
    const cardStats = db.prepare(`
        SELECT 
            COUNT(*) as total_cards,
            SUM(CASE WHEN reps > 0 THEN 1 ELSE 0 END) as reviewed_cards,
            SUM(CASE WHEN reps = 0 THEN 1 ELSE 0 END) as new_cards,
            SUM(CASE WHEN queue = 2 THEN 1 ELSE 0 END) as due_cards,
            AVG(reps) as avg_reviews
        FROM cards
    `).get();
    
    console.log(`\nCard Statistics:`);
    console.log(`  Total cards: ${cardStats.total_cards}`);
    console.log(`  Reviewed cards: ${cardStats.reviewed_cards}`);
    console.log(`  New (never reviewed) cards: ${cardStats.new_cards}`);
    console.log(`  Due cards: ${cardStats.due_cards}`);
    console.log(`  Average reviews per card: ${cardStats.avg_reviews.toFixed(2)}`);
    
    // Calculate review progress percentage
    const reviewProgress = ((cardStats.reviewed_cards / cardStats.total_cards) * 100).toFixed(1);
    console.log(`  Review progress: ${reviewProgress}%`);
    
    // Analyze audio fields in notes
    console.log(`\nAudio Analysis:`);
    const notes = db.prepare("SELECT flds FROM notes").all();
    
    let notesWithAudio = 0;
    let notesWithoutAudio = 0;
    let audioFieldPositions = new Set();
    
    notes.forEach(note => {
        const fields = note.flds.split('\x1f');
        let hasAudio = false;
        
        fields.forEach((field, index) => {
            // Check if field contains [sound:...] tags (Anki audio format)
            if (field.includes('[sound:') && field.includes(']')) {
                hasAudio = true;
                audioFieldPositions.add(index);
            }
        });
        
        if (hasAudio) {
            notesWithAudio++;
        } else {
            notesWithoutAudio++;
        }
    });
    
    console.log(`  Notes with audio: ${notesWithAudio}`);
    console.log(`  Notes without audio: ${notesWithoutAudio}`);
    console.log(`  Audio coverage: ${((notesWithAudio / totalNotes.count) * 100).toFixed(1)}%`);
    
    if (audioFieldPositions.size > 0) {
        console.log(`  Audio found in field positions: ${Array.from(audioFieldPositions).sort().join(', ')}`);
    }
    
    return {
        totalNotes: totalNotes.count,
        cardStats,
        reviewProgress: parseFloat(reviewProgress),
        audioStats: {
            notesWithAudio,
            notesWithoutAudio,
            audioCoverage: parseFloat(((notesWithAudio / totalNotes.count) * 100).toFixed(1)),
            audioFieldPositions: Array.from(audioFieldPositions).sort()
        }
    };
}

const parseApkgFile = async () => {
    console.log('Starting to parse APKG file...');
    return new Promise(async (resolve, reject) => {

        yauzl.open(file, { lazyEntries: true }, function (err, zipfile) {
            if (err) {
                console.error('Error opening file:', err);
                throw err;
            }
            console.log('File opened successfully, reading entries...');

            zipfile.readEntry();
            zipfile.on("entry", function (entry) {
                console.log('Found entry:', entry.fileName);
                // Try collection.anki21 first (intermediate format), then collection.anki2 (oldest format)
                if (entry.fileName === 'collection.anki21') {
                    console.log('Found collection.anki21 (intermediate format), processing...');
                    zipfile.openReadStream(entry, function (err, readStream) {
                        if (err) throw err;

                        // Read the SQLite database into a buffer
                        const chunks = [];
                        readStream.on('data', function (chunk) {
                            chunks.push(chunk);
                        });

                        readStream.on('end', async function () {
                            const buffer = Buffer.concat(chunks);
                            console.log('Database loaded into memory successfully');

                            try {
                                // Create SQLite database from buffer
                                const db = new Database(buffer);

                                // First, get a sample note for field detection
                                console.log('Getting sample note for field analysis...');
                                const sampleNote = db.prepare("SELECT flds FROM notes LIMIT 1").get();
                                
                                if (!sampleNote) {
                                    throw new Error('No notes found in database');
                                }

                                // First, let's do a diagnostic check
                                console.log('\n=== DATABASE DIAGNOSTIC ===');
                                
                                // Check all tables in the database
                                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
                                console.log('Available tables:', tables.map(t => t.name));
                                
                                // Check notes table structure
                                const noteColumns = db.prepare("PRAGMA table_info(notes)").all();
                                console.log('Notes table columns:', noteColumns.map(c => c.name));
                                
                                // Get first few notes with all details
                                const allNotesDebug = db.prepare("SELECT * FROM notes LIMIT 5").all();
                                console.log('First few notes (full data):');
                                allNotesDebug.forEach((note, i) => {
                                    console.log(`Note ${i + 1}:`, note);
                                    
                                    // Check if this is the dummy compatibility message
                                    if (note.flds && note.flds.includes('Please update to the latest Anki version')) {
                                        console.log('\n🚨 COMPATIBILITY ISSUE DETECTED! 🚨');
                                        console.log('This appears to be a dummy compatibility file.');
                                        console.log('Your real Korean vocabulary data is in collection.anki21b format.');
                                        console.log('\nYour deck DOES contain your progress and vocabulary!');
                                        console.log('The 7.5MB file size confirms this.');
                                    }
                                });
                                
                                // Check if there are other note-like tables
                                const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%note%'").all();
                                console.log('Note-related tables:', allTables);

                                // First, analyze the deck progress and audio status
                                const deckAnalysis = await analyzeDeckProgress(db);

                                // Detect field languages
                                console.log('Detecting field languages...');
                                const fieldDetection = await detectFieldLanguages(sampleNote, targetLang, knownLang);
                                
                                // Now get all notes (limited for testing)
                                console.log('Extracting notes with detected field structure...');
                                const notes = db.prepare("SELECT flds FROM notes ORDER BY RANDOM() LIMIT 3").all();
                                
                                // Extract the target language field from each note
                                const extracted = notes.map(note => {
                                    const fields = note.flds.split('\x1f');
                                    return fields[fieldDetection.targetLangIndex] || '';
                                });

                                // Close database
                                db.close();
                                resolve({ 
                                    extracted, 
                                    fieldDetection,
                                    deckAnalysis
                                });

                            } catch (error) {
                                console.error('Error creating database from buffer:', error);
                                reject(error);
                            }
                        });
                    });
                } else if (entry.fileName === 'collection.anki2') {
                    console.log('Found collection.anki2, processing...');
                    zipfile.openReadStream(entry, function (err, readStream) {
                        if (err) throw err;

                        // Read the SQLite database into a buffer
                        const chunks = [];
                        readStream.on('data', function (chunk) {
                            chunks.push(chunk);
                        });

                        readStream.on('end', async function () {
                            const buffer = Buffer.concat(chunks);
                            console.log('Database loaded into memory successfully');

                            try {
                                // Create SQLite database from buffer
                                const db = new Database(buffer);

                                // First, get a sample note for field detection
                                console.log('Getting sample note for field analysis...');
                                const sampleNote = db.prepare("SELECT flds FROM notes LIMIT 1").get();
                                
                                if (!sampleNote) {
                                    throw new Error('No notes found in database');
                                }

                                // First, let's do a diagnostic check
                                console.log('\n=== DATABASE DIAGNOSTIC ===');
                                
                                // Check all tables in the database
                                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
                                console.log('Available tables:', tables.map(t => t.name));
                                
                                // Check notes table structure
                                const noteColumns = db.prepare("PRAGMA table_info(notes)").all();
                                console.log('Notes table columns:', noteColumns.map(c => c.name));
                                
                                // Get first few notes with all details
                                const allNotesDebug = db.prepare("SELECT * FROM notes LIMIT 5").all();
                                console.log('First few notes (full data):');
                                allNotesDebug.forEach((note, i) => {
                                    console.log(`Note ${i + 1}:`, note);
                                    
                                    // Check if this is the dummy compatibility message
                                    if (note.flds && note.flds.includes('Please update to the latest Anki version')) {
                                        console.log('\n🚨 COMPATIBILITY ISSUE DETECTED! 🚨');
                                        console.log('This appears to be a dummy compatibility file.');
                                        console.log('Your real Korean vocabulary data is in collection.anki21 format.');
                                        console.log('\nYour deck DOES contain your progress and vocabulary!');
                                        console.log('The 7.5MB file size confirms this.');
                                    }
                                });
                                
                                // Check if there are other note-like tables
                                const allTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%note%'").all();
                                console.log('Note-related tables:', allTables);

                                // First, analyze the deck progress and audio status
                                const deckAnalysis = await analyzeDeckProgress(db);

                                // Detect field languages
                                console.log('Detecting field languages...');
                                const fieldDetection = await detectFieldLanguages(sampleNote, targetLang, knownLang);
                                
                                // Now get all notes (limited for testing)
                                console.log('Extracting notes with detected field structure...');
                                const notes = db.prepare("SELECT flds FROM notes ORDER BY RANDOM() LIMIT 3").all();
                                
                                // Extract the target language field from each note
                                const extracted = notes.map(note => {
                                    const fields = note.flds.split('\x1f');
                                    return fields[fieldDetection.targetLangIndex] || '';
                                });

                                // Close database
                                db.close();
                                resolve({ 
                                    extracted, 
                                    fieldDetection,
                                    deckAnalysis
                                });

                            } catch (error) {
                                console.error('Error creating database from buffer:', error);
                                reject(error);
                            }
                        });
                    });
                } else {
                    // Continue reading next entry
                    console.log('Skipping entry:', entry.fileName);
                    zipfile.readEntry();
                }
            });

            zipfile.on("end", function() {
                console.log('Reached end of zip file without finding collection.anki2');
                reject(new Error('collection.anki2 not found in the .apkg file'));
            });
        });
    });
}

// Available voices for variety
const voices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

/**
 * Create safe filename from Korean text
 */
function createSafeFilename(koreanText) {
    // Remove special characters and replace spaces with underscores
    return koreanText.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').trim();
}

/**
 * Generate Korean audio using gpt-4o-audio-preview (alternative method)
 */
async function generateAudioWithGPT4oAudio(text, voice) {
    console.log(`🎤 Trying gpt-4o-audio-preview with voice: ${voice}`);
    
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: voice, format: "mp3" },
            messages: [
                {
                    role: "system",
                    content: "You are a native Korean speaker. Pronounce ONLY the single Korean word provided. Say it once clearly and naturally, then stop. Do not repeat it, do not explain it, do not say anything else."
                },
                {
                    role: "user",
                    content: `Pronounce this Korean word once: ${text}`
                }
            ]
        });

        if (response.choices[0].message.audio?.data) {
            const audioBase64 = response.choices[0].message.audio.data;
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            console.log(`✅ GPT-4o-audio generated ${audioBuffer.byteLength} bytes`);
            return audioBuffer;
        } else {
            throw new Error('No audio data in GPT-4o-audio response');
        }
    } catch (error) {
        console.log(`❌ GPT-4o-audio failed: ${error.message}`);
        throw error;
    }
}

/**
 * Generate Korean audio using gpt-4o-mini-tts (TTS API method)
 */
async function generateAudioWithGPT4oMiniTTS(text, voice) {
    console.log(`🎤 Trying gpt-4o-mini-tts via TTS API with voice: ${voice}`);
    
    try {
        const audioResponse = await openai.audio.speech.create({
            model: "gpt-4o-mini-tts",
            voice: voice,
            input: text,
            response_format: "mp3"
        });

        const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
        console.log(`✅ GPT-4o-mini-tts generated ${audioBuffer.byteLength} bytes`);
        return audioBuffer;
    } catch (error) {
        console.log(`❌ GPT-4o-mini-tts failed: ${error.message}`);
        throw error;
    }
}

/**
 * Generate Korean audio using gpt-4o-audio-preview (preferred method)
 */
async function generateKoreanAudioForNote(koreanText, noteId, index) {
    try {
        const safeText = createSafeFilename(koreanText);
        const filename = `${safeText}_gpt4o.mp3`;
        const filepath = `audio/${filename}`;
        
        // Check if audio already exists and is valid size
        if (fs.existsSync(filepath)) {
            const stats = fs.statSync(filepath);
            if (stats.size <= 50000) { // 50KB limit
                console.log(`⏭️  Audio already exists: ${filename} (${stats.size} bytes)`);
                return [{
                    filename,
                    filepath,
                    status: 'exists',
                    method: 'gpt-4o-audio-preview',
                    voice: 'unknown', // Can't determine original voice from existing file
                    koreanText,
                    fileSize: stats.size,
                    validation: null // No validation performed on existing files
                }];
            } else {
                console.log(`🗑️  Removing oversized audio: ${filename} (${stats.size} bytes > 50KB)`);
                fs.unlinkSync(filepath);
            }
        }
        
        console.log(`🎵 Generating audio for: "${koreanText}" → ${filename}`);
        
        const maxAttempts = 3;
        let attempt = 0;
        let lastVoice = null; // Track the last voice attempted for error reporting
        
        while (attempt < maxAttempts) {
            attempt++;
            
            // Randomly select a voice for each attempt
            const randomVoice = voices[Math.floor(Math.random() * voices.length)];
            lastVoice = randomVoice; // Store for error reporting
            console.log(`🎭 Attempt ${attempt}/${maxAttempts} using voice: ${randomVoice}`);
            
            try {
                const audioBuffer = await generateAudioWithGPT4oAudio(koreanText, randomVoice);
                
                // Check file size before validation
                if (audioBuffer.byteLength > 50000) {
                    console.log(`⚠️  Audio too large: ${audioBuffer.byteLength} bytes (> 50KB), retrying...`);
                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                        continue;
                    } else {
                        throw new Error(`Audio consistently too large after ${maxAttempts} attempts`);
                    }
                }
                
                // Validate the generated audio
                const validation = await validateAudioBuffer(audioBuffer, koreanText, 'ko');
                
                if (!validation.isValid) {
                    console.log(`❌ Audio validation failed: ${validation.error || 'Transcription mismatch'}`);
                    console.log(`   Expected: "${koreanText}"`);
                    console.log(`   Got: "${validation.transcription}"`);
                    
                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                        continue;
                    } else {
                        throw new Error(`Audio validation failed after ${maxAttempts} attempts. Last transcription: "${validation.transcription}"`);
                    }
                }
                
                console.log(`✅ Audio validation successful: "${validation.transcription}"`);
                
                fs.writeFileSync(filepath, audioBuffer);
                console.log(`💾 Audio saved: ${filepath} (${audioBuffer.byteLength} bytes)`);
                
                return [{
                    filename,
                    filepath,
                    status: 'generated',
                    method: 'gpt-4o-audio-preview',
                    voice: randomVoice,
                    koreanText,
                    fileSize: audioBuffer.byteLength,
                    attempts: attempt,
                    validation: {
                        isValid: validation.isValid,
                        transcription: validation.transcription
                    }
                }];
                
            } catch (error) {
                // Check for specific errors that should stop generation
                const errorMessage = error.message.toLowerCase();
                if (errorMessage.includes('rate limit') || 
                    errorMessage.includes('quota') || 
                    errorMessage.includes('insufficient') ||
                    errorMessage.includes('billing')) {
                    throw new Error(`CRITICAL: ${error.message}`);
                }
                
                console.error(`❌ Attempt ${attempt} failed: ${error.message}`);
                if (attempt >= maxAttempts) {
                    return [{
                        filename: null,
                        filepath: null,
                        status: 'error',
                        method: 'gpt-4o-audio-preview',
                        voice: lastVoice, // Include the last voice that was attempted
                        error: error.message,
                        koreanText,
                        attempts: attempt,
                        validation: error.message.includes('validation failed') ? {
                            isValid: false,
                            transcription: error.message.includes('Last transcription:') ? 
                                error.message.split('Last transcription: "')[1]?.split('"')[0] || '' : ''
                        } : null
                    }];
                }
                
                // Wait before retry
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
    } catch (error) {
        console.error(`❌ Failed to generate audio for "${koreanText}":`, error.message);
        return [{
            filename: null,
            filepath: null,
            status: 'error',
            method: 'gpt-4o-audio-preview',
            voice: lastVoice || 'unknown', // Include last attempted voice, or 'unknown' if none attempted
            error: error.message,
            koreanText,
            validation: null // No validation info available for general errors
        }];
    }
}

// Run the parser
// Add a debug mode
const debugMode = args.includes('--debug');

if (debugMode) {
    console.log('=== DEBUG MODE: Examining deck structure ===');
    parseApkgFile().then(async (result) => {
        console.log('=== PARSING COMPLETE ===');
        console.log('Field detection:', result.fieldDetection);
        console.log('Deck analysis:', result.deckAnalysis);
        console.log('Sample extractions:', result.extracted.slice(0, 3));
        process.exit(0);
    }).catch(error => {
        console.error('Error in debug mode:', error);
        process.exit(1);
    });
} else {
parseApkgFile().then(async (result) => {
    const { extracted, fieldDetection, deckAnalysis } = result;
    
    console.log('\n=== FIELD DETECTION RESULTS ===');
    console.log(`Target Language: ${fieldDetection.targetLanguage} (Field ${fieldDetection.targetLangIndex})`);
    console.log(`Known Language: ${fieldDetection.knownLanguage} (Field ${fieldDetection.knownLangIndex})`);
    console.log(`Analysis: ${fieldDetection.analysis}`);
    
    console.log('\n=== SUMMARY REPORT ===');
    console.log(`📚 Deck: Korean Vocabulary by Evita`);
    console.log(`📊 Total Notes: ${deckAnalysis.totalNotes}`);
    console.log(`📈 Review Progress: ${deckAnalysis.reviewProgress}% (${deckAnalysis.cardStats.reviewed_cards}/${deckAnalysis.cardStats.total_cards} cards reviewed)`);
    console.log(`🔊 Audio Coverage: ${deckAnalysis.audioStats.audioCoverage}% (${deckAnalysis.audioStats.notesWithAudio}/${deckAnalysis.totalNotes} notes have audio)`);
    console.log(`🆕 New Cards: ${deckAnalysis.cardStats.new_cards}`);
    console.log(`⏰ Due Cards: ${deckAnalysis.cardStats.due_cards}`);
    console.log(`🔄 Average Reviews per Card: ${deckAnalysis.cardStats.avg_reviews.toFixed(2)}`);
    
    if (deckAnalysis.audioStats.audioFieldPositions.length > 0) {
        console.log(`🎵 Audio found in field positions: ${deckAnalysis.audioStats.audioFieldPositions.join(', ')}`);
    }

    // Now let's generate audio for notes without audio
    console.log('\n=== 🎵 AUDIO GENERATION PHASE ===');
    console.log(`🎯 Target: Generate audio for notes without existing audio`);
    console.log(`📁 Audio will be saved to: ./audio/`);
    console.log(`🎤 Using GPT-4o-audio-preview (preferred method)`);
    console.log(`🚀 Generating audio for ALL ${deckAnalysis.audioStats.notesWithoutAudio} missing notes...`);
    console.log(`💾 Progress will be saved continuously to avoid data loss`);
    console.log(`⚠️  Will stop immediately on rate limit or billing errors`);
    
    // We need to re-parse to get the full dataset for audio generation
    await generateAudioForNotesWithoutAudio(); // Generate for ALL missing notes

}).catch(error => {
    console.error('Error in main process:', error);
});

/**
 * Re-parse the deck and generate audio for notes without audio
 */
async function generateAudioForNotesWithoutAudio(maxCount = null) {
    return new Promise(async (resolve, reject) => {
        yauzl.open(file, { lazyEntries: true }, function (err, zipfile) {
            if (err) {
                reject(err);
                return;
            }

            zipfile.readEntry();
            zipfile.on("entry", function (entry) {
                if (entry.fileName === 'collection.anki21') {
                    zipfile.openReadStream(entry, function (err, readStream) {
                        if (err) {
                            reject(err);
                            return;
                        }

                        const chunks = [];
                        readStream.on('data', function (chunk) {
                            chunks.push(chunk);
                        });

                        readStream.on('end', async function () {
                            const buffer = Buffer.concat(chunks);
                            console.log('📊 Re-analyzing deck for audio generation...');

                            try {
                                const db = new Database(buffer);

                                // Get notes without audio (field 3 is empty or doesn't contain [sound:])
                                const query = `
                                    SELECT id, flds FROM notes 
                                    WHERE flds NOT LIKE '%[sound:%' 
                                    OR (
                                        LENGTH(TRIM(SUBSTR(flds, 
                                            INSTR(flds, '\x1F') + 1, 
                                            CASE WHEN INSTR(SUBSTR(flds, INSTR(flds, '\x1F') + 1), '\x1F') > 0 
                                                THEN INSTR(SUBSTR(flds, INSTR(flds, '\x1F') + 1), '\x1F') - 1
                                                ELSE LENGTH(flds) END
                                        ))) = 0
                                    )
                                    ORDER BY id
                                `;
                                
                                const notesWithoutAudio = maxCount ? 
                                    db.prepare(query + ' LIMIT ?').all(maxCount) : 
                                    db.prepare(query).all();

                                console.log(`🎯 Found ${notesWithoutAudio.length} notes without audio`);
                                if (maxCount) {
                                    console.log(`📝 Processing first ${maxCount} for testing`);
                                } else {
                                    console.log(`🚀 Processing ALL notes - this will take a while!`);
                                }

                                const audioResults = [];
                                let processedCount = 0;
                                let generatedCount = 0;
                                let skippedCount = 0;
                                let errorCount = 0;
                                const startTime = new Date();

                                for (const note of notesWithoutAudio) {
                                    const fields = note.flds.split('\x1f');
                                    const koreanText = fields[0]?.trim(); // Field 0 contains Korean
                                    const audioField = fields[3]?.trim(); // Field 3 contains audio

                                    processedCount++;
                                    
                                    // Progress reporting every 50 notes
                                    if (processedCount % 50 === 0 || processedCount === 1) {
                                        const elapsed = (new Date() - startTime) / 1000;
                                        const rate = processedCount / elapsed * 60; // notes per minute
                                        const remaining = notesWithoutAudio.length - processedCount;
                                        const eta = remaining / rate; // minutes
                                        
                                        console.log(`\n📊 PROGRESS UPDATE:`);
                                        console.log(`   Processed: ${processedCount}/${notesWithoutAudio.length} (${(processedCount/notesWithoutAudio.length*100).toFixed(1)}%)`);
                                        console.log(`   Generated: ${generatedCount} | Skipped: ${skippedCount} | Errors: ${errorCount}`);
                                        console.log(`   Rate: ${rate.toFixed(1)} notes/min | ETA: ${eta.toFixed(0)} minutes`);
                                    }
                                    
                                    console.log(`\n--- Note ${processedCount}/${notesWithoutAudio.length}: "${koreanText}" ---`);

                                    if (koreanText && koreanText.length > 0) {
                                        try {
                                            const results = await generateKoreanAudioForNote(koreanText, note.id, processedCount - 1);
                                            
                                            // Add each result to the results array
                                            for (const result of results) {
                                                audioResults.push({
                                                    noteId: note.id,
                                                    ...result
                                                });
                                                
                                                if (result.status === 'generated') {
                                                    generatedCount++;
                                                } else if (result.status === 'error') {
                                                    errorCount++;
                                                }
                                            }
                                            
                                            // Save progress every 25 notes to avoid losing work
                                            if (processedCount % 25 === 0) {
                                                const progressFilename = 'audio_generation_progress.json';
                                                fs.writeFileSync(progressFilename, JSON.stringify({
                                                    timestamp: new Date().toISOString(),
                                                    totalNotes: notesWithoutAudio.length,
                                                    processed: processedCount,
                                                    generated: generatedCount,
                                                    skipped: skippedCount,
                                                    errors: errorCount,
                                                    results: audioResults
                                                }, null, 2));
                                                console.log(`💾 Progress saved to ${progressFilename}`);
                                            }

                                            // Add delay ONLY if we actually generated audio (not for existing files)
                                            const wasGenerated = results.some(r => r.status === 'generated');
                                            if (wasGenerated && processedCount < notesWithoutAudio.length) {
                                                await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5s delay
                                            }
                                            
                                        } catch (error) {
                                            // Check for critical errors that should stop the process
                                            if (error.message.includes('CRITICAL:')) {
                                                console.error(`\n🛑 STOPPING DUE TO CRITICAL ERROR: ${error.message}`);
                                                console.log(`💾 Saving final progress before stopping...`);
                                                
                                                // Save final progress
                                                const finalProgressFilename = 'audio_generation_final.json';
                                                fs.writeFileSync(finalProgressFilename, JSON.stringify({
                                                    timestamp: new Date().toISOString(),
                                                    totalNotes: notesWithoutAudio.length,
                                                    processed: processedCount,
                                                    generated: generatedCount,
                                                    skipped: skippedCount,
                                                    errors: errorCount + 1,
                                                    stoppedReason: error.message,
                                                    results: audioResults
                                                }, null, 2));
                                                
                                                throw error; // Re-throw to stop execution
                                            }
                                            
                                                                        // Non-critical error, log and continue
                            console.error(`❌ Error processing note ${note.id}: ${error.message}`);
                            errorCount++;
                            audioResults.push({
                                noteId: note.id,
                                filename: null,
                                filepath: null,
                                status: 'error',
                                method: 'gpt-4o-audio-preview',
                                voice: 'unknown', // Voice unknown since this is a general processing error
                                error: error.message,
                                koreanText,
                                validation: null // No validation info for general processing errors
                            });
                                        }
                                    } else {
                                        console.log(`⚠️  Skipping - no Korean text found`);
                                        skippedCount++;
                                    }
                                }

                                db.close();

                                const endTime = new Date();
                                const totalTime = (endTime - startTime) / 1000; // seconds
                                
                                console.log('\n=== 🎵 AUDIO GENERATION COMPLETE ===');
                                console.log(`📊 FINAL STATISTICS:`);
                                console.log(`   Total processed: ${processedCount}/${notesWithoutAudio.length}`);
                                console.log(`   ✅ Generated: ${generatedCount} new audio files`);
                                console.log(`   ♻️  Already existed: ${audioResults.filter(r => r.status === 'exists').length}`);
                                console.log(`   ⚠️  Skipped: ${skippedCount}`);
                                console.log(`   ❌ Failed: ${errorCount}`);
                                console.log(`   ⏱️  Total time: ${(totalTime/60).toFixed(1)} minutes`);
                                console.log(`   📈 Rate: ${(processedCount / totalTime * 60).toFixed(1)} notes/minute`);

                                // Save results
                                const resultsFilename = 'audio_generation_results.json';
                                fs.writeFileSync(resultsFilename, JSON.stringify({
                                    timestamp: new Date().toISOString(),
                                    processed: processedCount,
                                    results: audioResults
                                }, null, 2));
                                console.log(`📄 Results saved to ${resultsFilename}`);

                                resolve(audioResults);

                            } catch (error) {
                                console.error('Error in audio generation:', error);
                                reject(error);
                            }
                        });
                    });
                } else {
                    zipfile.readEntry();
                }
            });

            zipfile.on("end", function() {
                reject(new Error('collection.anki21 not found in the .apkg file'));
            });
        });
    });
}
}
