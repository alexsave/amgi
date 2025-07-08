// Parse .apkg file using Node.js (read-only, no file saving)
const fs = require('fs');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const dotenv = require('dotenv');
dotenv.config();

const file = '';

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
 * Validates generated audio by transcribing it and checking if it matches expected text
 */
async function validateAndGenerateAudio(text, language = 'ko', maxAttempts = 3) {
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

const parseApkgFile = async () => {
    return new Promise(async (resolve, reject) => {

        yauzl.open(file, { lazyEntries: true }, function (err, zipfile) {
            if (err) throw err;

            zipfile.readEntry();
            zipfile.on("entry", function (entry) {
                // Find the collection.anki2 file
                if (entry.fileName === 'collection.anki2') {
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
                                    fieldDetection 
                                });

                            } catch (error) {
                                console.error('Error creating database from buffer:', error);
                                reject(error);
                            }
                        });
                    });
                }
            });
        });
    });
}

// Run the parser
parseApkgFile().then(async (result) => {
    const { extracted, fieldDetection } = result;
    
    console.log('\n=== FIELD DETECTION RESULTS ===');
    console.log(`Target Language: ${fieldDetection.targetLanguage} (Field ${fieldDetection.targetLangIndex})`);
    console.log(`Known Language: ${fieldDetection.knownLanguage} (Field ${fieldDetection.knownLangIndex})`);
    console.log(`Analysis: ${fieldDetection.analysis}`);
    
    console.log('\n=== EXTRACTED TEXTS ===');
    console.log(`Extracted ${fieldDetection.targetLanguage} strings:`, extracted);
    console.log(`Found ${extracted.length} ${fieldDetection.targetLanguage} strings`);

    // Generate audio for each target language string
    const audioResults = [];
    for (let i = 0; i < extracted.length; i++) {
        const targetText = extracted[i];
        if (targetText && targetText.trim().length > 0) {
            try {
                const audioFilename = await generateTargetLanguageAudio(targetText, i, fieldDetection.targetLanguage);
                audioResults.push({
                    text: targetText,
                    language: fieldDetection.targetLanguage,
                    audio: audioFilename,
                    index: i
                });
                
                // Add small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`Failed to process "${targetText}":`, error);
                audioResults.push({
                    text: targetText,
                    language: fieldDetection.targetLanguage,
                    audio: null,
                    error: error.message,
                    index: i
                });
            }
        }
    }

    console.log('\n=== AUDIO GENERATION COMPLETE ===');
    console.log('Results:', audioResults);
    
    // Save results to JSON file
    const resultsFilename = `${fieldDetection.targetLanguage.toLowerCase()}_audio_results.json`;
    fs.writeFileSync(resultsFilename, JSON.stringify({
        fieldDetection,
        audioResults
    }, null, 2));
    console.log(`Results saved to ${resultsFilename}`);

}).catch(error => {
    console.error('Error in main process:', error);
});
