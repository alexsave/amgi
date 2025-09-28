// Unified Korean Deck Audio Processor
// Handles audio generation, deck creation, and timestamp fixing in one script
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const dotenv = require('dotenv');
const { exec } = require('child_process');
const { promisify } = require('util');

dotenv.config({ path: '../.env' });
const execAsync = promisify(exec);

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY
});

// Configuration
const CONFIG = {
    audioDir: 'audio',
    progressFile: 'deck_processing_progress.json',
    tempDir: 'temp_processing',
    voiceStatsFile: 'voice_performance_stats.json', // Voice performance tracking
    mismatchCacheFile: 'korean_mismatch_cache.json',
    skipListFile: 'korean_generation_skip_list.json',
    
    // Audio generation settings
    maxVoicesPerWord: 10,
    maxAttemptsPerVoice: 2,
    audioValidationTimeout: 30000, // 30 seconds
    delayBetweenRequests: 500, // 0.5 seconds
    
    // Regeneration settings
    ignoreExistingGptAudio: true, // Set to true to regenerate all GPT audio regardless of existing files
    
    // Force regenerate specific words (user can modify this)
    forceRegenerateWords: [
        // Add Korean words here to force regeneration
        // '대사관', // embassy (example)
    ]
};

// Available voices for multi-voice fallback
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

// Simple JSON-backed mismatch cache for known non-equivalent pairs
class MismatchCache {
    constructor(cacheFilePath) {
        this.cacheFilePath = cacheFilePath;
        this.cache = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.cacheFilePath)) {
                const data = JSON.parse(fs.readFileSync(this.cacheFilePath, 'utf8'));
                return data && typeof data === 'object' ? data : {};
            }
        } catch (error) {
            console.log('⚠️ Could not load mismatch cache, starting fresh');
        }
        return {};
    }

    save() {
        try {
            fs.writeFileSync(this.cacheFilePath, JSON.stringify(this.cache, null, 2));
        } catch (error) {
            console.error('⚠️ Could not save mismatch cache:', error.message);
        }
    }

    static normalize(text) {
        return (text || '')
            .toLowerCase()
            .trim()
            .replace(/[^\w\s가-힣]/g, '');
    }

    hasMismatch(a, b) {
        const A = MismatchCache.normalize(a);
        const B = MismatchCache.normalize(b);
        if (!A || !B || A === B) return false;
        const listA = this.cache[A] || [];
        const listB = this.cache[B] || [];
        return listA.includes(B) || listB.includes(A);
    }

    addMismatch(a, b) {
        const A = MismatchCache.normalize(a);
        const B = MismatchCache.normalize(b);
        if (!A || !B || A === B) return;
        if (!this.cache[A]) this.cache[A] = [];
        if (!this.cache[B]) this.cache[B] = [];
        if (!this.cache[A].includes(B)) this.cache[A].push(B);
        if (!this.cache[B].includes(A)) this.cache[B].push(A);
        this.save();
    }
}

// JSON-backed skip list for words that consistently fail generation
class SkipList {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
                return Array.isArray(data) ? new Set(data) : new Set();
            }
        } catch (error) {
            console.log('⚠️ Could not load skip list, starting fresh');
        }
        return new Set();
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(Array.from(this.data), null, 2));
        } catch (error) {
            console.error('⚠️ Could not save skip list:', error.message);
        }
    }

    static normalize(text) {
        return (text || '').toLowerCase().trim().replace(/[^\w\s가-힣]/g, '');
    }

    has(word) {
        return this.data.has(SkipList.normalize(word));
    }

    add(word) {
        const key = SkipList.normalize(word);
        if (!key) return;
        if (!this.data.has(key)) {
            this.data.add(key);
            this.save();
        }
    }

    remove(word) {
        const key = SkipList.normalize(word);
        if (this.data.delete(key)) {
            this.save();
        }
    }
}

// Voice performance tracking
class VoiceStats {
    constructor() {
        this.statsFile = CONFIG.voiceStatsFile;
        this.stats = this.loadStats();
    }
    
    loadStats() {
        try {
            if (fs.existsSync(this.statsFile)) {
                const data = JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
                console.log(`📊 Loaded voice performance stats from ${this.statsFile}`);
                return data;
            }
        } catch (error) {
            console.log('⚠️ Could not load voice stats, starting fresh');
        }
        
        // Initialize fresh stats for all voices
        const freshStats = {
            metadata: {
                created: new Date().toISOString(),
                lastUpdated: new Date().toISOString(),
                totalAttempts: 0,
                totalSuccesses: 0
            },
            voices: {}
        };
        
        VOICES.forEach(voice => {
            freshStats.voices[voice] = {
                attempts: 0,
                successes: 0,
                failures: 0,
                validationFailures: 0,
                sizeFailures: 0,
                generationFailures: 0,
                successRate: 0,
                avgAttemptsPerSuccess: 0,
                lastUsed: null
            };
        });
        
        return freshStats;
    }
    
    recordAttempt(voice, result) {
        if (!this.stats.voices[voice]) {
            this.stats.voices[voice] = {
                attempts: 0,
                successes: 0,
                failures: 0,
                validationFailures: 0,
                sizeFailures: 0,
                generationFailures: 0,
                successRate: 0,
                avgAttemptsPerSuccess: 0,
                lastUsed: null
            };
        }
        
        const voiceStats = this.stats.voices[voice];
        voiceStats.attempts++;
        voiceStats.lastUsed = new Date().toISOString();
        
        this.stats.metadata.totalAttempts++;
        this.stats.metadata.lastUpdated = new Date().toISOString();
        
        if (result.success) {
            voiceStats.successes++;
            this.stats.metadata.totalSuccesses++;
        } else {
            voiceStats.failures++;
            
            // Categorize failure types
            if (result.failureReason === 'validation') {
                voiceStats.validationFailures++;
            } else if (result.failureReason === 'size') {
                voiceStats.sizeFailures++;
            } else if (result.failureReason === 'generation') {
                voiceStats.generationFailures++;
            }
        }
        
        // Update calculated stats
        voiceStats.successRate = voiceStats.attempts > 0 ? (voiceStats.successes / voiceStats.attempts) : 0;
        voiceStats.avgAttemptsPerSuccess = voiceStats.successes > 0 ? (voiceStats.attempts / voiceStats.successes) : 0;
        
        this.saveStats();
    }
    
    saveStats() {
        try {
            fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2));
        } catch (error) {
            console.error('⚠️ Could not save voice stats:', error.message);
        }
    }
    
    getBestVoices(limit = 3) {
        const sortedVoices = Object.entries(this.stats.voices)
            .filter(([voice, stats]) => stats.attempts >= 3) // Only consider voices with enough data
            .sort(([, a], [, b]) => {
                // Sort by success rate, then by fewer attempts per success
                if (b.successRate !== a.successRate) {
                    return b.successRate - a.successRate;
                }
                return a.avgAttemptsPerSuccess - b.avgAttemptsPerSuccess;
            });
        
        return sortedVoices.slice(0, limit).map(([voice]) => voice);
    }
    
    getWorstVoices(limit = 3) {
        const sortedVoices = Object.entries(this.stats.voices)
            .filter(([voice, stats]) => stats.attempts >= 3) // Only consider voices with enough data
            .sort(([, a], [, b]) => {
                // Sort by success rate (ascending), then by more attempts per success
                if (a.successRate !== b.successRate) {
                    return a.successRate - b.successRate;
                }
                return b.avgAttemptsPerSuccess - a.avgAttemptsPerSuccess;
            });
        
        return sortedVoices.slice(0, limit).map(([voice]) => voice);
    }
    
    printSummary() {
        console.log('\n📊 VOICE PERFORMANCE SUMMARY:');
        console.log(`   Total attempts: ${this.stats.metadata.totalAttempts}`);
        console.log(`   Total successes: ${this.stats.metadata.totalSuccesses}`);
        console.log(`   Overall success rate: ${(this.stats.metadata.totalSuccesses / this.stats.metadata.totalAttempts * 100).toFixed(1)}%`);
        
        const voicesWithData = Object.entries(this.stats.voices)
            .filter(([voice, stats]) => stats.attempts > 0)
            .sort(([, a], [, b]) => b.successRate - a.successRate);
        
        if (voicesWithData.length > 0) {
            console.log('\n🎭 Voice Rankings (by success rate):');
            voicesWithData.forEach(([voice, stats], index) => {
                const rank = index + 1;
                const emoji = rank <= 3 ? '🏆' : rank <= 6 ? '🥉' : '📉';
                console.log(`   ${emoji} ${rank}. ${voice}: ${(stats.successRate * 100).toFixed(1)}% (${stats.successes}/${stats.attempts}) - Avg ${stats.avgAttemptsPerSuccess.toFixed(1)} attempts/success`);
            });
        }
    }
}

// Global voice stats instance
const voiceStats = new VoiceStats();

// Progress state management
class ProcessState {
    constructor(inputFile) {
        this.inputFile = inputFile;
        this.baseName = path.basename(inputFile, '.apkg');
        this.outputFile = `${this.baseName.replace(' (with Audio 2)', '')} (with Audio 3).apkg`;
        this.progressFile = `${this.baseName}_progress.json`;
        this.audioDir = CONFIG.audioDir;
        
        this.state = {
            phase: 'init', // init, audio_generation, deck_creation, timestamp_fixing, complete
            audioGeneration: {
                completed: false,
                totalNotes: 0,
                processedCount: 0,
                generatedCount: 0,
                errorCount: 0,
                results: []
            },
            deckCreation: {
                completed: false,
                notesUpdated: 0,
                audioFilesAdded: 0
            },
            timestampFixing: {
                completed: false,
                reviewsUpdated: 0
            },
            startTime: null,
            lastSaveTime: null
        };
        
        this.loadProgress();
    }
    
    loadProgress() {
        try {
            if (fs.existsSync(this.progressFile)) {
                const saved = JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));
                if (saved.inputFile === this.inputFile) {
                    this.state = { ...this.state, ...saved };
                    console.log(`📄 Loaded previous progress from ${this.progressFile}`);
                    console.log(`   Last phase: ${this.state.phase}`);
                    console.log(`   Audio generation: ${this.state.audioGeneration.processedCount}/${this.state.audioGeneration.totalNotes} processed`);
                }
            }
        } catch (error) {
            console.log('⚠️ Could not load previous progress, starting fresh');
        }
    }
    
    save() {
        try {
            this.state.lastSaveTime = new Date().toISOString();
            fs.writeFileSync(this.progressFile, JSON.stringify(this.state, null, 2));
        } catch (error) {
            console.error('⚠️ Could not save progress:', error.message);
        }
    }
    
    canResumeFrom(phase) {
        const phases = ['init', 'audio_generation', 'deck_creation', 'timestamp_fixing', 'complete'];
        const currentIndex = phases.indexOf(this.state.phase);
        const targetIndex = phases.indexOf(phase);
        return currentIndex >= targetIndex;
    }
}

// Audio Tools and Functions (from index.js)
const audioTranscriptionTools = [{
    "type": "function",
    "function": {
        "name": "transcribe_audio",
        "description": "Transcribe the audio content without any bias or expectations",
        "parameters": {
            "type": "object",
            "properties": {
                "transcription": {
                    "type": "string",
                    "description": "The exact transcribed text from the audio"
                },
                "confidence": {
                    "type": "string",
                    "enum": ["high", "medium", "low"],
                    "description": "Confidence level in the transcription"
                },
                "language_detected": {
                    "type": "string",
                    "description": "The detected language of the audio"
                }
            },
            "required": ["transcription", "confidence", "language_detected"]
        }
    }
}];

const koreanPhonologyTools = [{
    "type": "function",
    "function": {
        "name": "check_korean_phonological_equivalence",
        "description": "Check if two Korean texts sound EXACTLY the same when pronounced, accounting for Korean phonological rules",
        "parameters": {
            "type": "object",
            "properties": {
                "sounds_equivalent": {
                    "type": "boolean",
                    "description": "Whether the two Korean texts sound EXACTLY the same when pronounced by a native Korean speaker"
                },
                "explanation": {
                    "type": "string",
                    "description": "Explanation of the phonological analysis and why they do/don't sound equivalent"
                },
                "phonological_rules_applied": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of Korean phonological rules that apply"
                }
            },
            "required": ["sounds_equivalent", "explanation", "phonological_rules_applied"]
        }
    }
}];

const fieldDetectionTools = [{
    "type": "function",
    "function": {
        "name": "detect_field_languages",
        "description": "Analyze the fields to detect which languages are present and their positions",
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

// Utility Functions
function createSafeFilename(text) {
    return text.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').trim();
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Korean phonological equivalence check
async function checkKoreanPhonologicalEquivalence(expectedText, transcribedText) {
    try {
        const response = await openai.chat.completions.create({
            model: "o4-mini-2025-04-16",
            messages: [
                {
                    role: "user",
                    content: `You are a Korean phonology expert. Analyze if these two Korean texts sound EXACTLY the same when pronounced.

Expected (written): "${expectedText}"
Transcribed (heard): "${transcribedText}"

Consider Korean phonological rules:
1. Final consonant neutralization: ㅅ,ㅆ,ㅈ,ㅊ,ㅌ,ㅎ → /t/, ㄱ,ㅋ,ㄲ → /k/, ㅂ,ㅍ,ㅃ → /p/
2. Consonant assimilation between syllables  
3. Liaison and sound changes in connected speech
4. Consonant cluster simplification
5. Other Korean phonological processes

Use the function to report whether they sound exactly the same.`
                }
            ],
            tools: koreanPhonologyTools,
            tool_choice: { type: "function", function: { name: "check_korean_phonological_equivalence" } }
        });

        const toolCall = response.choices[0].message.tool_calls?.[0];
        if (!toolCall) {
            return { 
                isPhonologicallyEquivalent: false, 
                explanation: 'No phonological analysis response',
                rulesApplied: []
            };
        }

        const result = JSON.parse(toolCall.function.arguments);
        return {
            isPhonologicallyEquivalent: result.sounds_equivalent,
            explanation: result.explanation,
            rulesApplied: result.phonological_rules_applied
        };
    } catch (error) {
        console.error('❌ Korean phonological equivalence check failed:', error);
        return { 
            isPhonologicallyEquivalent: false, 
            explanation: `Error: ${error.message}`,
            rulesApplied: []
        };
    }
}

// Audio validation
async function validateAudioBuffer(audioBuffer, expectedText, language = 'ko') {
    try {
        const audioBase64 = audioBuffer.toString('base64');

        const transcriptionResponse = await openai.chat.completions.create({
            model: "gpt-4o-audio-preview",
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "mp3" },
            messages: [
                {
                    role: "system",
                    content: `You are an audio transcription assistant. Listen carefully to the audio and transcribe exactly what you hear. The audio is expected to be in ${language === 'ko' ? 'Korean' : language} language.`
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Please transcribe this audio content. Do not make assumptions about what it should say - just transcribe exactly what you hear.`
                        },
                        {
                            type: "input_audio",
                            input_audio: { data: audioBase64, format: "mp3" }
                        }
                    ]
                }
            ],
            tools: audioTranscriptionTools,
            tool_choice: { type: "function", function: { name: "transcribe_audio" } }
        });

        const toolCall = transcriptionResponse.choices[0].message.tool_calls?.[0];
        if (!toolCall) {
            return { isValid: false, transcription: '', error: 'No transcription response' };
        }

        const transcriptionResult = JSON.parse(toolCall.function.arguments);
        
        // Early reject: empty transcription is an obvious non-match
        if (!transcriptionResult.transcription || transcriptionResult.transcription.trim().length === 0) {
            return {
                isValid: false,
                transcription: transcriptionResult.transcription || '',
                confidence: transcriptionResult.confidence,
                languageDetected: transcriptionResult.language_detected,
                similarity: 0,
                comparisonReason: 'empty_transcription',
                phonologyExplanation: 'Empty transcription does not match the expected text',
                error: null
            };
        }
        
        // Compare transcription with expected text
        // Korean-aware normalization - preserve Hangul characters (가-힣), ASCII word chars, and spaces
        const normalize = (text) => text.toLowerCase().trim().replace(/[^\w\s가-힣]/g, '');
        const normalizedTranscription = normalize(transcriptionResult.transcription);
        const normalizedExpected = normalize(expectedText);
        
        console.log(`🔤 Comparison: Expected "${normalizedExpected}" vs Transcribed "${normalizedTranscription}"`);
        
        let isValid = false;
        let similarity = 0;
        let reason = 'no_match';
        let phonologyExplanation = null;
        const mismatchCache = new MismatchCache(CONFIG.mismatchCacheFile);
        
        // First try exact match
        if (normalizedTranscription === normalizedExpected) {
            isValid = true;
            similarity = 1.0;
            reason = 'exact_match';
        } else {
            // If we've already seen this pair as a mismatch (in either direction), skip the phonology call
            if (mismatchCache.hasMismatch(expectedText, transcriptionResult.transcription)) {
                isValid = false;
                similarity = 0;
                reason = 'cached_non_match';
                phonologyExplanation = `Known non-match from cache: "${expectedText}" ≠ "${transcriptionResult.transcription}"`;
            } else {
                // Try Korean phonological equivalence
                const phonologyCheck = await checkKoreanPhonologicalEquivalence(expectedText, transcriptionResult.transcription);
                if (phonologyCheck.isPhonologicallyEquivalent) {
                    isValid = true;
                    similarity = 0.95;
                    reason = 'korean_phonological_match';
                    phonologyExplanation = phonologyCheck.explanation;
                } else {
                    phonologyExplanation = phonologyCheck.explanation;
                    // Record this pair as a known non-match to avoid future API calls
                    mismatchCache.addMismatch(expectedText, transcriptionResult.transcription);
                }
            }
        }

        return {
            isValid: isValid && transcriptionResult.transcription.trim().length > 0,
            transcription: transcriptionResult.transcription,
            confidence: transcriptionResult.confidence,
            languageDetected: transcriptionResult.language_detected,
            similarity: similarity,
            comparisonReason: reason,
            phonologyExplanation: phonologyExplanation,
            error: null
        };
    } catch (error) {
        console.error('❌ Audio validation failed:', error);
        return { isValid: false, transcription: '', error: error.message };
    }
}

// Audio generation with GPT-4o-audio-preview
async function generateAudioWithGPT4oAudio(text, voice) {
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
            return audioBuffer;
        } else {
            throw new Error('No audio data in GPT-4o-audio response');
        }
    } catch (error) {
        throw error;
    }
}

// Check if a Korean word should be regenerated
function shouldRegenerateAudio(koreanText, currentAudioField) {
    // Check if word is in the force regenerate list
    if (CONFIG.forceRegenerateWords.includes(koreanText.trim())) {
        return { shouldRegenerate: true, reason: 'in_force_regenerate_list' };
    }
    
    // If ignoreExistingGptAudio is true, regenerate all GPT audio regardless of existing files
    if (CONFIG.ignoreExistingGptAudio && currentAudioField && currentAudioField.trim().length > 0) {
        const soundMatch = currentAudioField.match(/\[sound:([^\]]+)\]/);
        if (soundMatch) {
            const audioFilename = soundMatch[1];
            
            // If it's GPT audio, regenerate it
            if (audioFilename.endsWith('gpt4o.mp3')) {
                return { shouldRegenerate: true, reason: 'ignore_existing_gpt_audio_flag' };
            }
            
            // If audio doesn't end with "gpt4o.mp3", it's original good audio - DON'T regenerate
            return { shouldRegenerate: false, reason: 'original_good_audio' };
        }
    }
    
    if (currentAudioField && currentAudioField.trim().length > 0) {
        const soundMatch = currentAudioField.match(/\[sound:([^\]]+)\]/);
        if (soundMatch) {
            const audioFilename = soundMatch[1];
            
            // If audio doesn't end with "gpt4o.mp3", it's original good audio - DON'T regenerate
            if (!audioFilename.endsWith('gpt4o.mp3')) {
                return { shouldRegenerate: false, reason: 'original_good_audio' };
            }
            
            // Check if corresponding audio file exists
            const audioPath = path.join(CONFIG.audioDir, audioFilename);
            if (!fs.existsSync(audioPath)) {
                return { shouldRegenerate: true, reason: 'gpt4o_audio_file_missing' };
            }
            
            return { shouldRegenerate: false, reason: 'gpt4o_audio_exists_and_valid' };
        }
    }
    
    return { shouldRegenerate: true, reason: 'no_audio_or_invalid_format' };
}

// Generate Korean audio for a single note
async function generateKoreanAudioForNote(koreanText) {
    try {
        // Skip list check (unless explicitly forced)
        const skipList = new SkipList(CONFIG.skipListFile);
        if (!CONFIG.forceRegenerateWords.includes(koreanText.trim()) && skipList.has(koreanText)) {
            return {
                filename: null,
                filepath: null,
                status: 'skipped',
                error: 'Word is in skip list',
                koreanText,
            };
        }

        const safeText = createSafeFilename(koreanText);
        const filename = `${safeText}_gpt4o.mp3`;
        const filepath = path.join(CONFIG.audioDir, filename);
        
        // Check if audio already exists and is valid size
        if (fs.existsSync(filepath) && !CONFIG.forceRegenerateWords.includes(koreanText.trim())) {
            const stats = fs.statSync(filepath);
            if (stats.size <= 50000) { // 50KB limit
                return {
                    filename,
                    filepath,
                    status: 'exists',
                    koreanText,
                    fileSize: stats.size
                };
            } else {
                fs.unlinkSync(filepath); // Remove oversized file
            }
        } else if (fs.existsSync(filepath) && CONFIG.forceRegenerateWords.includes(koreanText.trim())) {
            fs.unlinkSync(filepath); // Force regeneration
        }
        
        console.log(`🎵 Generating audio for: "${koreanText}" → ${filename}`);
        
        const shuffledVoices = [...VOICES].sort(() => Math.random() - 0.5);
        let totalAttempts = 0;
        
        for (let voiceIndex = 0; voiceIndex < Math.min(CONFIG.maxVoicesPerWord, shuffledVoices.length); voiceIndex++) {
            const currentVoice = shuffledVoices[voiceIndex];
            
            for (let voiceAttempt = 1; voiceAttempt <= CONFIG.maxAttemptsPerVoice; voiceAttempt++) {
                totalAttempts++;
                
                try {
                    const audioBuffer = await generateAudioWithGPT4oAudio(koreanText, currentVoice);
                    
                    // Check file size
                    if (audioBuffer.byteLength > 50000) {
                        // Record size failure
                        voiceStats.recordAttempt(currentVoice, { 
                            success: false, 
                            failureReason: 'size',
                            details: `Audio too large: ${audioBuffer.byteLength} bytes` 
                        });
                        
                        if (voiceAttempt < CONFIG.maxAttemptsPerVoice) {
                            await sleep(500);
                            continue;
                        } else {
                            break; // Try next voice
                        }
                    }
                    
                    // Validate the generated audio
                    console.log(`🔍 Validating audio for "${koreanText}"...`);
                    const validation = await validateAudioBuffer(audioBuffer, koreanText, 'ko');
                    
                    if (validation.isValid) {
                        const matchType = validation.comparisonReason === 'exact_match' ? 'exact' : 'phonological';
                        console.log(`✅ Validation passed (${matchType}): "${validation.transcription}" (${(validation.similarity * 100).toFixed(1)}% similarity)`);
                        if (validation.phonologyExplanation) {
                            console.log(`   🔊 ${validation.phonologyExplanation}`);
                        }
                        
                        // Record success
                        voiceStats.recordAttempt(currentVoice, { 
                            success: true, 
                            validationType: matchType,
                            similarity: validation.similarity 
                        });
                    } else {
                        console.log(`❌ Validation failed: Expected "${koreanText}", got "${validation.transcription}" (${(validation.similarity * 100).toFixed(1)}% similarity)`);
                        if (validation.phonologyExplanation) {
                            console.log(`   🔊 ${validation.phonologyExplanation}`);
                        }
                        
                        // Record validation failure
                        voiceStats.recordAttempt(currentVoice, { 
                            success: false, 
                            failureReason: 'validation',
                            details: `Expected "${koreanText}", got "${validation.transcription}"`,
                            similarity: validation.similarity
                        });
                        
                        if (voiceAttempt < CONFIG.maxAttemptsPerVoice) {
                            console.log(`   🔄 Retrying with same voice (${voiceAttempt + 1}/${CONFIG.maxAttemptsPerVoice})`);
                            await sleep(500);
                            continue;
                        } else {
                            console.log(`   ❌ Voice ${currentVoice} failed validation ${CONFIG.maxAttemptsPerVoice} times, trying next voice...`);
                            break; // Try next voice
                        }
                    }
                    
                    // Success! Save the audio
                    fs.writeFileSync(filepath, audioBuffer);
                    
                    return {
                        filename,
                        filepath,
                        status: 'generated',
                        voice: currentVoice,
                        koreanText,
                        fileSize: audioBuffer.byteLength,
                        attempts: totalAttempts,
                        validation: validation
                    };
                    
                } catch (error) {
                    // Record generation failure
                    voiceStats.recordAttempt(currentVoice, { 
                        success: false, 
                        failureReason: 'generation',
                        details: error.message
                    });
                    
                    // Check for critical errors
                    const errorMessage = error.message.toLowerCase();
                    if (errorMessage.includes('rate limit') || 
                        errorMessage.includes('quota') || 
                        errorMessage.includes('insufficient') ||
                        errorMessage.includes('billing')) {
                        throw new Error(`CRITICAL: ${error.message}`);
                    }
                    
                    if (voiceAttempt >= CONFIG.maxAttemptsPerVoice) {
                        break; // Try next voice
                    }
                    
                    await sleep(500);
                }
            }
        }
        
        // All voices failed — add to skip list to avoid repeated retries on next runs
        skipList.add(koreanText);
        return {
            filename: null,
            filepath: null,
            status: 'error',
            error: `Failed with all voices after ${totalAttempts} attempts`,
            koreanText,
            attempts: totalAttempts
        };
        
    } catch (error) {
        return {
            filename: null,
            filepath: null,
            status: 'error',
            error: error.message,
            koreanText,
            attempts: 0
        };
    }
}

// Field detection
async function detectFieldLanguages(sampleNote) {
    const fields = sampleNote.flds.split('\x1f');
    
    const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
            {
                role: "system",
                content: "You are a language detection expert. Analyze the provided flashcard fields to identify which field contains which language."
            },
            {
                role: "user",
                content: `Analyze this flashcard note and identify the languages in each field:

Fields:
${fields.map((field, index) => `Field ${index}: "${field}"`).join('\n')}

Determine which field contains the target/foreign language and which contains the known language.`
            }
        ],
        tools: fieldDetectionTools,
        tool_choice: { type: "function", function: { name: "detect_field_languages" } }
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall) {
        throw new Error('No tool call in field detection response');
    }

    return JSON.parse(toolCall.function.arguments);
}

// Main processing phases
class DeckProcessor {
    constructor(inputFile) {
        this.state = new ProcessState(inputFile);
        this.fieldDetection = null;
        this.volumeReferenceData = null;
        this.skipAudio = false;
        
        // Ensure directories exist
        if (!fs.existsSync(CONFIG.audioDir)) {
            fs.mkdirSync(CONFIG.audioDir, { recursive: true });
        }
        if (!fs.existsSync(CONFIG.tempDir)) {
            fs.mkdirSync(CONFIG.tempDir, { recursive: true });
        }
    }
    
    async process() {
        try {
            this.state.state.startTime = new Date().toISOString();
            console.log('=== KOREAN DECK AUDIO PROCESSOR ===');
            console.log(`Input: ${this.state.inputFile}`);
            console.log(`Output: ${this.state.outputFile}`);
            console.log('');
            
            // Phase 1: Audio Generation
            if (this.skipAudio) {
                console.log('⏭️ Skipping audio generation (requested)');
            } else if (!this.state.state.audioGeneration.completed) {
                await this.audioGenerationPhase();
            } else {
                console.log('✅ Audio generation already completed, skipping...');
            }
            
            // Phase 2: Deck Creation
            if (!this.state.state.deckCreation.completed) {
                await this.deckCreationPhase();
            } else {
                console.log('✅ Deck creation already completed, skipping...');
            }
            
            // Phase 3: Timestamp Fixing
            if (!this.state.state.timestampFixing.completed) {
                await this.timestampFixingPhase();
            } else {
                console.log('✅ Timestamp fixing already completed, skipping...');
            }
            
            this.state.state.phase = 'complete';
            this.state.save();
            
            console.log('\n=== 🎉 PROCESSING COMPLETE ===');
            console.log(`📂 Output file: ${this.state.outputFile}`);
            const stats = fs.statSync(this.state.outputFile);
            console.log(`📏 File size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
            console.log('');
            console.log('🎉 Your enhanced Korean deck is ready!');
            console.log('   Import it into Anki to use cards with enhanced audio.');
            console.log('   All your review history and statistics are preserved.');
            
        } catch (error) {
            console.error('\n❌ Processing failed:', error.message);
            this.state.save();
            throw error;
        }
    }
    
    async audioGenerationPhase() {
        console.log('\n=== 🎵 PHASE 1: AUDIO GENERATION ===');
        this.state.state.phase = 'audio_generation';
        
        return new Promise((resolve, reject) => {
            yauzl.open(this.state.inputFile, { lazyEntries: true }, async (err, zipfile) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                zipfile.readEntry();
                zipfile.on("entry", (entry) => {
                    if (entry.fileName === 'collection.anki21' || entry.fileName === 'collection.anki2') {
                        zipfile.openReadStream(entry, async (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            const chunks = [];
                            readStream.on('data', chunk => chunks.push(chunk));
                            readStream.on('end', async () => {
                                try {
                                    const buffer = Buffer.concat(chunks);
                                    const db = new Database(buffer);
                                    
                                    // Get sample note for field detection if not done already
                                    if (!this.fieldDetection) {
                                        console.log('🔍 Analyzing deck structure...');
                                        const sampleNote = db.prepare("SELECT flds FROM notes LIMIT 1").get();
                                        this.fieldDetection = await detectFieldLanguages(sampleNote);
                                        console.log(`   Target Language: ${this.fieldDetection.targetLanguage} (Field ${this.fieldDetection.targetLangIndex})`);
                                        console.log(`   Known Language: ${this.fieldDetection.knownLanguage} (Field ${this.fieldDetection.knownLangIndex})`);
                                    }
                                    
                                    // Get all notes that need regeneration
                                    const allNotes = db.prepare("SELECT id, flds FROM notes ORDER BY id").all();
                                    let notesToRegenerate = [];
                                    
                                    for (const note of allNotes) {
                                        const fields = note.flds.split('\x1f');
                                        const koreanText = fields[this.fieldDetection.targetLangIndex]?.trim();
                                        const audioField = fields[3]?.trim(); // Audio field is typically field 3
                                        
                                        if (koreanText && koreanText.length > 0) {
                                            const regenerateCheck = shouldRegenerateAudio(koreanText, audioField);
                                            if (regenerateCheck.shouldRegenerate) {
                                                notesToRegenerate.push({
                                                    ...note,
                                                    koreanText,
                                                    audioField,
                                                    regenerateReason: regenerateCheck.reason
                                                });
                                            }
                                        }
                                    }
                                    
                                    // Apply maxNotes limit if specified
                                    if (this.maxNotes && notesToRegenerate.length > this.maxNotes) {
                                        notesToRegenerate.splice(this.maxNotes);
                                        console.log(`🔢 Limited to first ${this.maxNotes} notes for testing`);
                                    }
                                    
                                    this.state.state.audioGeneration.totalNotes = notesToRegenerate.length;
                                    console.log(`🎯 Found ${notesToRegenerate.length} notes that need audio generation`);
                                    
                                    if (notesToRegenerate.length === 0) {
                                        console.log('✅ No audio generation needed');
                                        this.state.state.audioGeneration.completed = true;
                                        this.state.save();
                                        db.close();
                                        resolve();
                                        return;
                                    }
                                    
                                    // Shuffle notesToRegenerate
                                    notesToRegenerate = notesToRegenerate.sort(() => Math.random() - 0.5);
                            
                                    
                                    // Process notes for audio generation
                                    const startIndex = this.state.state.audioGeneration.processedCount;
                                    for (let i = startIndex; i < notesToRegenerate.length; i++) {
                                        const note = notesToRegenerate[i];
                                        
                                        try {
                                            console.log(`\n--- Note ${i + 1}/${notesToRegenerate.length}: "${note.koreanText}" ---`);
                                            const result = await generateKoreanAudioForNote(note.koreanText);
                                            
                                            this.state.state.audioGeneration.results.push(result);
                                            this.state.state.audioGeneration.processedCount = i + 1;
                                            
                                            if (result.status === 'generated') {
                                                this.state.state.audioGeneration.generatedCount++;
                                                console.log(`✅ Generated: ${result.filename}`);
                                            } else if (result.status === 'exists') {
                                                console.log(`⏭️ Already exists: ${result.filename}`);
                                            } else if (result.status === 'skipped') {
                                                console.log(`⏭️ Skipped (in skip list): ${note.koreanText}`);
                                            } else {
                                                this.state.state.audioGeneration.errorCount++;
                                                console.log(`❌ Failed: ${result.error}`);
                                            }
                                            
                                            // Save progress every 10 notes
                                            if ((i + 1) % 10 === 0) {
                                                this.state.save();
                                                console.log(`💾 Progress saved (${i + 1}/${notesToRegenerate.length})`);
                                            }
                                            
                                            // Add delay after successful generation
                                            if (result.status === 'generated' && i < notesToRegenerate.length - 1) {
                                                await sleep(CONFIG.delayBetweenRequests);
                                            }
                                            
                                        } catch (error) {
                                            if (error.message.includes('CRITICAL:')) {
                                                console.error(`\n🛑 CRITICAL ERROR: ${error.message}`);
                                                this.state.save();
                                                db.close();
                                                reject(error);
                                                return;
                                            }
                                            
                                            this.state.state.audioGeneration.errorCount++;
                                            this.state.state.audioGeneration.results.push({
                                                filename: null,
                                                status: 'error',
                                                error: error.message,
                                                koreanText: note.koreanText
                                            });
                                        }
                                    }
                                    
                                    this.state.state.audioGeneration.completed = true;
                                    this.state.save();
                                    
                                    console.log(`\n✅ Audio generation complete:`);
                                    console.log(`   Generated: ${this.state.state.audioGeneration.generatedCount}`);
                                    console.log(`   Errors: ${this.state.state.audioGeneration.errorCount}`);
                                    
                                    // Display voice performance summary
                                    voiceStats.printSummary();
                                    
                                    db.close();
                                    resolve();
                                    
                                } catch (error) {
                                    reject(error);
                                }
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });
                
                zipfile.on("end", () => {
                    reject(new Error('No collection database found in .apkg file'));
                });
            });
        });
    }
    
    async deckCreationPhase() {
        console.log('\n=== 📦 PHASE 2: DECK CREATION ===');
        this.state.state.phase = 'deck_creation';
        
        // Create temporary output file
        const tempOutputFile = `${this.state.baseName}_temp.apkg`;
        
        return new Promise((resolve, reject) => {
            // Scan audio directory
            console.log('🎵 Scanning for available audio files...');
            let audioFiles = [];
            try {
                const files = fs.readdirSync(CONFIG.audioDir);
                audioFiles = files.filter(file => file.endsWith('_gpt4o.mp3'));
                console.log(`   Found ${audioFiles.length} audio files`);
            } catch (error) {
                console.log('⚠️ No audio directory found, creating deck without additional audio');
            }
            
            // Create audio mapping
            const audioMapping = new Map();
            audioFiles.forEach(filename => {
                const koreanText = filename.replace('_gpt4o.mp3', '');
                audioMapping.set(koreanText, {
                    filename: filename,
                    filepath: path.join(CONFIG.audioDir, filename),
                    koreanText: koreanText
                });
            });
            
            yauzl.open(this.state.inputFile, { lazyEntries: true }, (err, sourceZipfile) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const outputZip = new yazl.ZipFile();
                const outputStream = fs.createWriteStream(tempOutputFile);
                outputZip.outputStream.pipe(outputStream);
                
                let audioFilesToAdd = new Set();
                let completeMediaMapping = {};
                
                sourceZipfile.readEntry();
                
                sourceZipfile.on("entry", async (entry) => {
                    if (entry.fileName === 'collection.anki21' || entry.fileName === 'collection.anki2') {
                        // Process the main database
                        const collectionEntryName = entry.fileName;
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            const chunks = [];
                            readStream.on('data', chunk => chunks.push(chunk));
                            readStream.on('end', async () => {
                                try {
                                    const buffer = Buffer.concat(chunks);
                                    const db = new Database(buffer);
                                    
                                    console.log('🔄 Processing collection database...');
                                    
                                    // Generate new IDs to avoid conflicts
                                    let idCounter = Date.now() * 1000;
                                    const generateNewId = () => ++idCounter;
                                    const generateNewGuid = () => {
                                        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                                        let result = '';
                                        for (let i = 0; i < 10; i++) {
                                            result += chars.charAt(Math.floor(Math.random() * chars.length));
                                        }
                                        return result;
                                    };
                                    
                                    // Update notes with audio references
                                    const notes = db.prepare("SELECT id, flds, guid FROM notes").all();
                                    const updateStmt = db.prepare("UPDATE notes SET flds = ?, id = ?, guid = ? WHERE id = ?");
                                    const updateCardsStmt = db.prepare("UPDATE cards SET nid = ? WHERE nid = ?");
                                    
                                    let updatedCount = 0;
                                    const noteIdMapping = new Map();
                                    
                                    for (const note of notes) {
                                        const oldId = note.id;
                                        const newId = generateNewId();
                                        const newGuid = generateNewGuid();
                                        noteIdMapping.set(oldId, newId);
                                        
                                        const fields = note.flds.split('\x1f');
                                        let updatedFields = note.flds;
                                        
                                        // Find Korean text and add audio if available
                                        let koreanText = null;
                                        let audioInfo = null;
                                        
                                        for (let i = 0; i < Math.min(3, fields.length); i++) {
                                            const fieldText = fields[i]?.trim();
                                            if (fieldText && audioMapping.has(fieldText)) {
                                                koreanText = fieldText;
                                                audioInfo = audioMapping.get(fieldText);
                                                break;
                                            }
                                        }
                                        
                                        if (audioInfo) {
                                            // Use the generated audio's own unique filename (based on Korean text)
                                            // to avoid massive duplication from reused card numbers
                                            const safeFilename = audioInfo.filename;
                                            
                                            // Set audio reference in field 3
                                            fields[3] = `[sound:${safeFilename}]`;
                                            updatedFields = fields.join('\x1f');
                                            
                                            audioFilesToAdd.add({
                                                oldFilename: audioInfo.filename,
                                                newFilename: safeFilename,
                                                koreanText: audioInfo.koreanText
                                            });
                                            updatedCount++;
                                        }
                                        
                                        updateStmt.run(updatedFields, newId, newGuid, oldId);
                                        updateCardsStmt.run(newId, oldId);
                                    }
                                    
                                    // Update card IDs
                                    const allCards = db.prepare("SELECT id, nid FROM cards").all();
                                    const cardIdMapping = new Map();
                                    
                                    for (const card of allCards) {
                                        const oldCardId = card.id;
                                        const newCardId = generateNewId();
                                        cardIdMapping.set(oldCardId, newCardId);
                                        
                                        const updateCardIdStmt = db.prepare("UPDATE cards SET id = ? WHERE id = ?");
                                        updateCardIdStmt.run(newCardId, oldCardId);
                                    }
                                    
                                    // Update revlog
                                    for (const [oldCardId, newCardId] of cardIdMapping) {
                                        const updateRevlogStmt = db.prepare("UPDATE revlog SET cid = ? WHERE cid = ?");
                                        updateRevlogStmt.run(newCardId, oldCardId);
                                    }
                                    
                                    // Update collection and deck metadata
                                    const newCollectionId = Date.now();
                                    const currentTime = Math.floor(Date.now() / 1000);
                                    
                                    const updateColStmt = db.prepare("UPDATE col SET id = ?, mod = ?");
                                    updateColStmt.run(newCollectionId, currentTime);
                                    
                                    // Update deck name and ID
                                    const deckStmt = db.prepare("SELECT decks FROM col");
                                    const deckData = deckStmt.get();
                                    if (deckData?.decks) {
                                        const decks = JSON.parse(deckData.decks);
                                        const newDecks = {};
                                        
                                        for (const [deckId, deck] of Object.entries(decks)) {
                                            const newDeckId = Date.now() + Math.floor(Math.random() * 100000);
                                            const newDeck = {
                                                ...deck,
                                                name: 'Korean Vocabulary by Evita (with Audio 3)',
                                                id: newDeckId,
                                                mod: Date.now()
                                            };
                                            newDecks[newDeckId] = newDeck;
                                            
                                            // Update cards to reference new deck
                                            const updateCardDeckStmt = db.prepare("UPDATE cards SET did = ? WHERE did = ?");
                                            updateCardDeckStmt.run(newDeckId, parseInt(deckId));
                                        }
                                        
                                        const updateDeckStmt = db.prepare("UPDATE col SET decks = ?");
                                        updateDeckStmt.run(JSON.stringify(newDecks));
                                    }
                                    
                                    this.state.state.deckCreation.notesUpdated = updatedCount;
                                    console.log(`✅ Updated ${updatedCount} notes with audio references`);
                                    
                                    // Serialize database
                                    const serialized = db.serialize();
                                    db.close();
                                    
                                    outputZip.addBuffer(Buffer.from(serialized), collectionEntryName);
                                    sourceZipfile.readEntry();
                                    
                                } catch (error) {
                                    reject(error);
                                }
                            });
                        });
                    } else if (entry.fileName === 'media') {
                        // Process media mapping
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            const chunks = [];
                            readStream.on('data', chunk => chunks.push(chunk));
                            readStream.on('end', () => {
                                // Parse existing media
                                let existingMedia = {};
                                try {
                                    const existingContent = Buffer.concat(chunks).toString();
                                    if (existingContent.trim()) {
                                        existingMedia = JSON.parse(existingContent);
                                    }
                                } catch (error) {
                                    // Start fresh if no existing media
                                }
                                
                                // Add new audio files with de-duplication by filename
                                const existingIds = Object.keys(existingMedia).map(id => parseInt(id));
                                let nextMediaId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
                                
                                completeMediaMapping = { ...existingMedia };
                                const filenameToId = new Map(Object.entries(existingMedia).map(([id, name]) => [name, id]));
                                
                                for (const audioFile of audioFilesToAdd) {
                                    const filename = audioFile.newFilename;
                                    if (filenameToId.has(filename)) {
                                        // Reuse existing media id for the same filename
                                        const reuseId = filenameToId.get(filename);
                                        completeMediaMapping[reuseId] = filename; // ensure mapping retains the filename
                                    } else {
                                        completeMediaMapping[nextMediaId] = filename;
                                        filenameToId.set(filename, String(nextMediaId));
                                        nextMediaId++;
                                    }
                                }
                                
                                const mediaBuffer = Buffer.from(JSON.stringify(completeMediaMapping));
                                outputZip.addBuffer(mediaBuffer, 'media');
                                sourceZipfile.readEntry();
                            });
                        });
                    } else if (/^\d+$/.test(entry.fileName)) {
                        // Copy existing media files
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            outputZip.addReadStream(readStream, entry.fileName);
                            sourceZipfile.readEntry();
                        });
                    } else {
                        // Copy other files
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            outputZip.addReadStream(readStream, entry.fileName);
                            sourceZipfile.readEntry();
                        });
                    }
                });
                
                sourceZipfile.on("end", () => {
                    // Add audio files
                    let addedAudioCount = 0;
                    for (const [mediaId, newFilename] of Object.entries(completeMediaMapping)) {
                        const audioFileInfo = Array.from(audioFilesToAdd).find(af => af.newFilename === newFilename);
                        if (audioFileInfo) {
                            const audioPath = path.join(CONFIG.audioDir, audioFileInfo.oldFilename);
                            if (fs.existsSync(audioPath)) {
                                outputZip.addFile(audioPath, mediaId);
                                addedAudioCount++;
                            }
                        }
                    }
                    
                    this.state.state.deckCreation.audioFilesAdded = addedAudioCount;
                    console.log(`🎵 Added ${addedAudioCount} audio files to deck`);
                    
                    outputZip.end();
                    
                    outputStream.on('close', () => {
                        this.state.state.deckCreation.completed = true;
                        this.state.save();
                        console.log('✅ Deck creation complete');
                        resolve(tempOutputFile);
                    });
                });
            });
        });
    }
    
    async timestampFixingPhase() {
        console.log('\n=== ⏰ PHASE 3: TIMESTAMP FIXING ===');
        this.state.state.phase = 'timestamp_fixing';
        
        const tempFile = `${this.state.baseName}_temp.apkg`;
        
        return new Promise((resolve, reject) => {
            yauzl.open(tempFile, { lazyEntries: true }, (err, sourceZipfile) => {
                if (err) {
                    reject(err);
                    return;
                }
                
                const outputZip = new yazl.ZipFile();
                const outputStream = fs.createWriteStream(this.state.outputFile);
                outputZip.outputStream.pipe(outputStream);
                
                sourceZipfile.readEntry();
                
                sourceZipfile.on("entry", (entry) => {
                    if (entry.fileName === 'collection.anki21') {
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            
                            const chunks = [];
                            readStream.on('data', chunk => chunks.push(chunk));
                            readStream.on('end', () => {
                                const buffer = Buffer.concat(chunks);
                                const db = new Database(buffer);
                                
                                console.log('📊 Fixing review timestamps...');
                                
                                // Get timestamp range
                                const timestampRange = db.prepare("SELECT MIN(id) as earliest, MAX(id) as latest, COUNT(*) as count FROM revlog").get();
                                
                                if (timestampRange.count > 0) {
                                    const now = Date.now();
                                    const latestReview = timestampRange.latest;
                                    const earliestReview = timestampRange.earliest;
                                    const reviewSpan = latestReview - earliestReview;
                                    
                                    // Shift all reviews to end 1 hour ago
                                    const targetLatest = now - (1 * 60 * 60 * 1000); // 1 hour ago
                                    const timeOffset = targetLatest - latestReview;
                                    
                                    console.log(`   Shifting ${timestampRange.count} reviews by ${Math.round(timeOffset / (1000 * 60 * 60 * 24))} days`);
                                    
                                    const updateStmt = db.prepare("UPDATE revlog SET id = id + ?");
                                    const result = updateStmt.run(timeOffset);
                                    
                                    this.state.state.timestampFixing.reviewsUpdated = result.changes;
                                }
                                
                                // Update collection modification time
                                const currentTime = Math.floor(Date.now() / 1000);
                                const updateColStmt = db.prepare("UPDATE col SET mod = ?");
                                updateColStmt.run(currentTime);
                                
                                const serialized = db.serialize();
                                db.close();
                                
                                outputZip.addBuffer(Buffer.from(serialized), entry.fileName);
                                sourceZipfile.readEntry();
                            });
                        });
                    } else {
                        // Copy all other files
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            outputZip.addReadStream(readStream, entry.fileName);
                            sourceZipfile.readEntry();
                        });
                    }
                });
                
                sourceZipfile.on("end", () => {
                    outputZip.end();
                    
                    outputStream.on('close', () => {
                        // Clean up temp file
                        try {
                            fs.unlinkSync(tempFile);
                        } catch (error) {
                            // Ignore cleanup errors
                        }
                        
                        this.state.state.timestampFixing.completed = true;
                        this.state.save();
                        console.log('✅ Timestamp fixing complete');
                        resolve();
                    });
                });
            });
        });
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h') || args.length === 0) {
        console.log(`
Korean Deck Audio Processor

Usage: node process-deck.js <path-to-apkg-file> [options]

Options:
  --help, -h           Show this help message
  --force-words="단어,단어2"  Comma-separated list of Korean words to force regenerate
  --max-notes=N        Maximum number of notes to process (for testing)
  --skip-audio         Skip audio generation and just rebuild deck/media

Examples:
  node process-deck.js "Korean Vocabulary.apkg"
  node process-deck.js "Korean Vocabulary.apkg" --force-words="대사관,학교"
  node process-deck.js "Korean Vocabulary.apkg" --max-notes=10

The script will:
1. Generate audio for Korean vocabulary using GPT-4o
2. Create a new .apkg deck with embedded audio
3. Fix review timestamps for proper Anki statistics

Progress is saved continuously and the script can be resumed if interrupted.
        `);
        process.exit(0);
    }
    
    const inputFile = args[0];
    
    if (!fs.existsSync(inputFile)) {
        console.error(`❌ Input file not found: ${inputFile}`);
        process.exit(1);
    }
    
    // Parse skip audio
    const skipAudio = args.includes('--skip-audio');

    // Parse force regenerate words option
    const forceWordsArg = args.find(arg => arg.startsWith('--force-words='));
    if (forceWordsArg) {
        const wordsStr = forceWordsArg.split('=')[1];
        CONFIG.forceRegenerateWords = wordsStr.split(',').map(w => w.trim());
        console.log(`🔄 Force regenerating: ${CONFIG.forceRegenerateWords.join(', ')}`);
    }
    
    // Parse max notes option
    const maxNotesArg = args.find(arg => arg.startsWith('--max-notes='));
    let maxNotes = null;
    if (maxNotesArg) {
        maxNotes = parseInt(maxNotesArg.split('=')[1]);
        if (isNaN(maxNotes) || maxNotes <= 0) {
            console.error(`❌ Invalid max-notes value: ${maxNotesArg.split('=')[1]}`);
            process.exit(1);
        }
        console.log(`🔢 Processing limited to ${maxNotes} notes for testing`);
    }
    
    try {
        const processor = new DeckProcessor(inputFile);
        processor.skipAudio = skipAudio;
        processor.maxNotes = maxNotes; // Pass the limit to the processor
        await processor.process();
    } catch (error) {
        console.error('❌ Processing failed:', error.message);
        process.exit(1);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⚠️ Interrupted by user. Progress has been saved.');
    console.log('Run the same command again to resume from where you left off.');
    
    // Dump voice stats before exit
    if (voiceStats && voiceStats.stats.metadata.totalAttempts > 0) {
        voiceStats.printSummary();
        console.log(`\n📄 Voice stats saved to: ${CONFIG.voiceStatsFile}`);
    }
    
    process.exit(0);
});

if (require.main === module) {
    main();
}

module.exports = { DeckProcessor, CONFIG };
