// Parse .apkg file using Node.js (read-only, no file saving)
const fs = require('fs');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

// For audio validation - duration (file size proxy) and volume level analysis
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Dynamic volume thresholds based on analyzing existing deck audio
let VOLUME_REFERENCE_DATA = null;

const file = 'Korean Vocabulary by Evita (with Audio).apkg';

// User-defined array of specific Korean words to regenerate (add words here as needed)
const FORCE_REGENERATE_WORDS = [
    '대사관', // embassy
];

// Parse command line arguments
const args = process.argv.slice(2);
const targetLang = args.find(arg => arg.startsWith('--target='))?.split('=')[1];
const knownLang = args.find(arg => arg.startsWith('--known='))?.split('=')[1];
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
    console.log(`
Audio Regeneration for Anki Decks

Usage: node index.js [options]

Options:
  --target=<language>    Hint for the target language (e.g., Spanish, Korean, French)
  --known=<language>     Hint for the known language (e.g., English, Spanish)
  --debug               Debug mode - analyze deck structure only
  --help, -h            Show this help message

Examples:
  node index.js                              # Smart regeneration with auto language detection
  node index.js --target=Korean --known=English  # Korean-English deck with language hints
  node index.js --debug                     # Analyze deck structure without generating audio

Regeneration Criteria:
  The script will regenerate audio for cards that meet ANY of these conditions:
  1. GPT4o audio file is missing from plusaudio/audio directory 
  2. Korean word is listed in FORCE_REGENERATE_WORDS array (edit the script to add words)
  3. No audio or invalid audio format
  
  PRESERVED: Original deck audio (non-gpt4o files) and valid GPT4o audio will NOT be regenerated unless specifically requested via FORCE_REGENERATE_WORDS.

Features:
  - Exact match + Korean phonological validation (handles sound change rules)
  - Uses o4-mini-2025-04-16 for superior Korean phonological analysis
  - Blind transcription testing (unbiased validation)  
  - Korean phonology awareness (갖 vs 갓, ㅅ/ㅈ/ㅊ → /t/ final sounds, etc.)
  - EXACTLY the same pronunciation validation (not just similar)
  - Audio duration validation (detects too short/long audio before expensive GPT calls)
  - Audio volume validation & boosting (uses deck analysis + ffmpeg to normalize quiet audio)
  - Multi-voice fallback (tries up to 5 different voices if validation fails)
  - Smart selective regeneration (only what needs updating)
  - Progress saving every 25 notes
  - Detailed statistics and breakdowns

Edit FORCE_REGENERATE_WORDS array in the script to manually specify words to regenerate.
`);
    process.exit(0);
}

console.log('=== ANKI DECK AUDIO REGENERATOR ===');
console.log(`Processing file: ${file}`);
console.log('Command line arguments:');
console.log(`  Target language: ${targetLang || 'auto-detect'}`);
console.log(`  Known language: ${knownLang || 'auto-detect'}`);
console.log('');

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || process.env.OPENAI_KEY
});

// Audio transcription tools for blind transcription
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

// Korean phonological equivalence tools
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
                    "description": "List of Korean phonological rules that apply (e.g., 'final_consonant_neutralization', 'consonant_assimilation')"
                }
            },
            "required": ["sounds_equivalent", "explanation", "phonological_rules_applied"]
        }
    }
}];

/**
 * Check if two Korean texts are phonologically equivalent (sound EXACTLY the same when pronounced)
 * even if they're spelled differently due to Korean sound change rules
 * Uses o4-mini-2025-04-16 for superior Korean phonological analysis
 */
async function checkKoreanPhonologicalEquivalence(expectedText, transcribedText) {
    try {
        console.log(`🔊 Checking Korean phonological equivalence...`);
        console.log(`   Expected: "${expectedText}"`);
        console.log(`   Transcribed: "${transcribedText}"`);
        
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

The transcription might reflect actual pronunciation rather than spelling. Determine if they sound EXACTLY identical when spoken by a native Korean speaker.

Use the function to report whether they sound exactly the same.`
                }
            ],
            tools: koreanPhonologyTools,
            tool_choice: { type: "function", function: { name: "check_korean_phonological_equivalence" } }
        });

        const toolCall = response.choices[0].message.tool_calls?.[0];
        if (!toolCall) {
            console.error('❌ No tool call in phonological equivalence response');
            return { 
                isPhonologicallyEquivalent: false, 
                explanation: 'No phonological analysis response',
                rulesApplied: []
            };
        }

        const result = JSON.parse(toolCall.function.arguments);
        console.log(`🔊 Phonological analysis: ${result.sounds_equivalent ? 'EQUIVALENT' : 'DIFFERENT'}`);
        console.log(`   Explanation: ${result.explanation}`);
        if (result.phonological_rules_applied.length > 0) {
            console.log(`   Rules applied: ${result.phonological_rules_applied.join(', ')}`);
        }

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

/**
 * Validate audio duration/size using file size as a proxy
 * Korean syllables typically take 0.2-0.5 seconds to pronounce
 * At standard MP3 quality, this translates to roughly 2-6 KB per syllable
 */
function validateAudioDuration(audioBuffer, koreanText) {
    const fileSizeBytes = audioBuffer.byteLength;
    const textLength = koreanText.length; // Korean characters (syllables)
    
    // Expected size ranges based on Korean syllable count
    // Conservative estimates: 1.5-8 KB per Korean syllable
    const minExpectedSize = Math.max(textLength * 1500, 3000); // At least 3KB minimum
    const maxExpectedSize = textLength * 8000; // Max 8KB per syllable
    
    console.log(`📏 Audio duration validation:`);
    console.log(`   Text: "${koreanText}" (${textLength} syllables)`);
    console.log(`   File size: ${fileSizeBytes} bytes`);
    console.log(`   Expected range: ${minExpectedSize}-${maxExpectedSize} bytes`);
    
    // Check if too short (likely silence or error)
    if (fileSizeBytes < minExpectedSize) {
        return {
            isValid: false,
            reason: 'too_short',
            details: `Audio too short: ${fileSizeBytes} bytes < ${minExpectedSize} bytes (min for ${textLength} syllables)`
        };
    }
    
    // Check if too long (likely repeated or wrong content)
    if (fileSizeBytes > maxExpectedSize) {
        return {
            isValid: false,
            reason: 'too_long', 
            details: `Audio too long: ${fileSizeBytes} bytes > ${maxExpectedSize} bytes (max for ${textLength} syllables)`
        };
    }
    
    // Duration seems reasonable
    const estimatedDuration = (fileSizeBytes / 16000).toFixed(1); // Rough estimate at 16kbps
    return {
        isValid: true,
        reason: 'duration_valid',
        details: `Audio duration appears valid (~${estimatedDuration}s for ${textLength} syllables)`
    };
}

/**
 * Analyze existing deck audio files to establish volume reference baselines
 * This analyzes non-gpt4o audio files to determine what good Korean audio should sound like
 */
async function analyzeReferenceAudioVolumes() {
    if (VOLUME_REFERENCE_DATA) {
        return VOLUME_REFERENCE_DATA; // Already analyzed
    }
    
    console.log('🔍 Analyzing existing deck audio to establish volume reference baselines...');
    
    try {
        // Extract audio files from the .apkg file to get reference data
        const yauzl = require('yauzl');
        const audioStats = [];
        
        return new Promise((resolve) => {
            yauzl.open(file, { lazyEntries: true }, function (err, zipfile) {
                if (err) {
                    console.log('   ⚠️  Could not open .apkg file for audio analysis, using default thresholds');
                    VOLUME_REFERENCE_DATA = {
                        meanVolumeRange: { min: -50, max: -8 },
                        maxVolumeThreshold: -1,
                        source: 'default_fallback',
                        sampleCount: 0
                    };
                    resolve(VOLUME_REFERENCE_DATA);
                    return;
                }

                const tempDir = path.join(__dirname, 'temp_audio_analysis');
                if (!fs.existsSync(tempDir)) {
                    fs.mkdirSync(tempDir);
                }

                zipfile.readEntry();
                zipfile.on("entry", function (entry) {
                    // Look for audio files that are NOT gpt4o.mp3 (original good audio)
                    if (entry.fileName.endsWith('.mp3') && !entry.fileName.includes('gpt4o.mp3')) {
                        console.log(`   📄 Found reference audio: ${entry.fileName}`);
                        
                        zipfile.openReadStream(entry, function (err, readStream) {
                            if (err) {
                                zipfile.readEntry();
                                return;
                            }

                            // Extract audio file temporarily for analysis
                            const tempAudioPath = path.join(tempDir, `ref_${Date.now()}_${path.basename(entry.fileName)}`);
                            const writeStream = fs.createWriteStream(tempAudioPath);
                            
                            readStream.pipe(writeStream);
                            writeStream.on('finish', async () => {
                                try {
                                    // Analyze this reference audio file
                                    const { stdout } = await execAsync(
                                        `ffprobe -i "${tempAudioPath}" -af "volumedetect" -vn -sn -dn -f null /dev/null 2>&1 | grep -E "(mean_volume|max_volume)"`
                                    );
                                    
                                    const meanVolumeMatch = stdout.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/);
                                    const maxVolumeMatch = stdout.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/);
                                    
                                    if (meanVolumeMatch && maxVolumeMatch) {
                                        const stats = {
                                            filename: entry.fileName,
                                            meanVolume: parseFloat(meanVolumeMatch[1]),
                                            maxVolume: parseFloat(maxVolumeMatch[1])
                                        };
                                        audioStats.push(stats);
                                        console.log(`      Mean: ${stats.meanVolume.toFixed(1)} dB, Max: ${stats.maxVolume.toFixed(1)} dB`);
                                    }
                                } catch (analyzeError) {
                                    console.log(`      ⚠️  Could not analyze ${entry.fileName}: ${analyzeError.message}`);
                                } finally {
                                    // Clean up temp file
                                    try {
                                        fs.unlinkSync(tempAudioPath);
                                    } catch (cleanupError) {
                                        // Ignore cleanup errors
                                    }
                                }
                                
                                zipfile.readEntry();
                            });
                        });
                    } else {
                        zipfile.readEntry();
                    }
                });

                zipfile.on("end", function() {
                    // Clean up temp directory
                    try {
                        fs.rmSync(tempDir, { recursive: true });
                    } catch (cleanupError) {
                        // Ignore cleanup errors
                    }
                    
                    if (audioStats.length === 0) {
                        console.log('   ⚠️  No reference audio files found, using default thresholds');
                        VOLUME_REFERENCE_DATA = {
                            meanVolumeRange: { min: -50, max: -8 },
                            maxVolumeThreshold: -1,
                            source: 'no_reference_files',
                            sampleCount: 0
                        };
                    } else {
                        // Calculate reference thresholds from existing audio
                        const meanVolumes = audioStats.map(s => s.meanVolume);
                        const maxVolumes = audioStats.map(s => s.maxVolume);
                        
                        const avgMeanVolume = meanVolumes.reduce((a, b) => a + b, 0) / meanVolumes.length;
                        const avgMaxVolume = maxVolumes.reduce((a, b) => a + b, 0) / maxVolumes.length;
                        
                        // Calculate standard deviation for mean volumes
                        const meanVolumeStdDev = Math.sqrt(
                            meanVolumes.map(v => Math.pow(v - avgMeanVolume, 2)).reduce((a, b) => a + b, 0) / meanVolumes.length
                        );
                        
                        // Set thresholds based on reference data:
                        // Allow ±2 standard deviations from the average, with reasonable bounds
                        const minMeanVolume = Math.max(avgMeanVolume - (2 * meanVolumeStdDev), -60); // Don't go below -60 dB
                        const maxMeanVolume = Math.min(avgMeanVolume + (2 * meanVolumeStdDev), 0);   // Don't go above 0 dB
                        const maxVolumeThreshold = Math.min(avgMaxVolume + (1 * meanVolumeStdDev), -0.5); // Allow some headroom
                        
                        VOLUME_REFERENCE_DATA = {
                            meanVolumeRange: { 
                                min: minMeanVolume, 
                                max: maxMeanVolume 
                            },
                            maxVolumeThreshold: maxVolumeThreshold,
                            source: 'deck_analysis',
                            sampleCount: audioStats.length,
                            referenceStats: {
                                avgMeanVolume: avgMeanVolume,
                                avgMaxVolume: avgMaxVolume,
                                meanVolumeStdDev: meanVolumeStdDev,
                                meanVolumeRange: [Math.min(...meanVolumes), Math.max(...meanVolumes)],
                                maxVolumeRange: [Math.min(...maxVolumes), Math.max(...maxVolumes)]
                            }
                        };
                        
                        console.log(`✅ Reference analysis complete: ${audioStats.length} audio files analyzed`);
                        console.log(`   Average levels: Mean ${avgMeanVolume.toFixed(1)} dB, Max ${avgMaxVolume.toFixed(1)} dB`);
                        console.log(`   Validation thresholds: Mean ${minMeanVolume.toFixed(1)} to ${maxMeanVolume.toFixed(1)} dB, Max < ${maxVolumeThreshold.toFixed(1)} dB`);
                    }
                    
                    resolve(VOLUME_REFERENCE_DATA);
                });
            });
        });
    } catch (error) {
        console.log(`   ⚠️  Reference audio analysis failed: ${error.message}, using default thresholds`);
        VOLUME_REFERENCE_DATA = {
            meanVolumeRange: { min: -50, max: -8 },
            maxVolumeThreshold: -1,
            source: 'analysis_error',
            sampleCount: 0
        };
        return VOLUME_REFERENCE_DATA;
    }
}

/**
 * Boost audio volume to match deck reference levels using ffmpeg
 * This normalizes quiet audio instead of regenerating it completely
 */
async function boostAudioVolume(audioBuffer, targetMeanVolume, currentMeanVolume, koreanText) {
    try {
        console.log(`🔊 Boosting audio volume from ${currentMeanVolume.toFixed(1)} dB to ~${targetMeanVolume.toFixed(1)} dB`);
        
        // Calculate the gain needed (in dB)
        const gainNeeded = targetMeanVolume - currentMeanVolume;
        console.log(`   Applying ${gainNeeded > 0 ? '+' : ''}${gainNeeded.toFixed(1)} dB gain`);
        
        // Create temporary files for processing
        const tempInputPath = path.join(__dirname, `temp_input_${Date.now()}.mp3`);
        const tempOutputPath = path.join(__dirname, `temp_output_${Date.now()}.mp3`);
        
        try {
            // Write input audio
            fs.writeFileSync(tempInputPath, audioBuffer);
            
            // Use ffmpeg to apply volume boost
            // Volume filter: volume=XdB applies X decibels of gain
            await execAsync(`ffmpeg -i "${tempInputPath}" -af "volume=${gainNeeded}dB" -c:a mp3 -b:a 128k "${tempOutputPath}" -y -loglevel error`);
            
            // Read the boosted audio
            const boostedBuffer = fs.readFileSync(tempOutputPath);
            
            console.log(`   ✅ Volume boosted: ${audioBuffer.byteLength} → ${boostedBuffer.byteLength} bytes`);
            
            return boostedBuffer;
            
        } finally {
            // Clean up temp files
            try {
                if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
        
    } catch (error) {
        console.log(`   ❌ Volume boost failed: ${error.message}, using original audio`);
        return audioBuffer; // Return original on failure
    }
}

/**
 * Validate audio volume levels using ffprobe and dynamic thresholds from deck analysis
 * Now includes automatic volume boosting for quiet audio instead of regeneration
 */
async function validateAudioVolume(audioBuffer, koreanText) {
    try {
        // Get reference thresholds from deck analysis
        const referenceData = await analyzeReferenceAudioVolumes();
        
        // Write audio buffer to a temporary file for analysis
        const tempFilePath = path.join(__dirname, `temp_audio_${Date.now()}.mp3`);
        fs.writeFileSync(tempFilePath, audioBuffer);
        
        console.log(`🔊 Audio volume validation (using ${referenceData.source} thresholds):`);
        
        try {
            // Use ffprobe to get volume statistics
            const { stdout } = await execAsync(
                `ffprobe -i "${tempFilePath}" -af "volumedetect" -vn -sn -dn -f null /dev/null 2>&1 | grep -E "(mean_volume|max_volume)"`
            );
            
            // Parse volume information from ffprobe output
            const meanVolumeMatch = stdout.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/);
            const maxVolumeMatch = stdout.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/);
            
            if (meanVolumeMatch && maxVolumeMatch) {
                const meanVolume = parseFloat(meanVolumeMatch[1]);
                const maxVolume = parseFloat(maxVolumeMatch[1]);
                
                console.log(`   Mean volume: ${meanVolume.toFixed(1)} dB`);
                console.log(`   Max volume: ${maxVolume.toFixed(1)} dB`);
                
                // Use dynamic thresholds based on deck analysis
                const { meanVolumeRange, maxVolumeThreshold } = referenceData;
                
                if (referenceData.source === 'deck_analysis') {
                    console.log(`   Reference range: Mean ${meanVolumeRange.min.toFixed(1)} to ${meanVolumeRange.max.toFixed(1)} dB, Max < ${maxVolumeThreshold.toFixed(1)} dB (from ${referenceData.sampleCount} deck files)`);
                }
                
                // Check against dynamic thresholds - try volume boosting for quiet audio
                if (meanVolume < meanVolumeRange.min) {
                    console.log(`   ⚠️  Audio too quiet: ${meanVolume.toFixed(1)} dB < ${meanVolumeRange.min.toFixed(1)} dB threshold`);
                    
                    // Try to boost the volume instead of failing immediately
                    const targetVolume = (meanVolumeRange.min + meanVolumeRange.max) / 2; // Aim for middle of range
                    const boostedBuffer = await boostAudioVolume(audioBuffer, targetVolume, meanVolume, koreanText);
                    
                    if (boostedBuffer !== audioBuffer) { // Boosting was applied
                        // Re-validate the boosted audio
                        const boostedTempPath = path.join(__dirname, `temp_boosted_${Date.now()}.mp3`);
                        fs.writeFileSync(boostedTempPath, boostedBuffer);
                        
                        try {
                            const { stdout: boostedStdout } = await execAsync(
                                `ffprobe -i "${boostedTempPath}" -af "volumedetect" -vn -sn -dn -f null /dev/null 2>&1 | grep -E "(mean_volume|max_volume)"`
                            );
                            
                            const boostedMeanMatch = boostedStdout.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/);
                            const boostedMaxMatch = boostedStdout.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/);
                            
                            if (boostedMeanMatch && boostedMaxMatch) {
                                const boostedMeanVolume = parseFloat(boostedMeanMatch[1]);
                                const boostedMaxVolume = parseFloat(boostedMaxMatch[1]);
                                
                                console.log(`   📈 After boosting: Mean ${boostedMeanVolume.toFixed(1)} dB, Max ${boostedMaxVolume.toFixed(1)} dB`);
                                
                                // Check if boosted audio is now in acceptable range
                                if (boostedMeanVolume >= meanVolumeRange.min && 
                                    boostedMeanVolume <= meanVolumeRange.max && 
                                    boostedMaxVolume <= maxVolumeThreshold) {
                                    
                                    fs.unlinkSync(boostedTempPath);
                                    return {
                                        isValid: true,
                                        reason: 'volume_boosted',
                                        details: `Audio volume boosted from ${meanVolume.toFixed(1)} dB to ${boostedMeanVolume.toFixed(1)} dB (now within deck reference range)`,
                                        meanVolume: boostedMeanVolume,
                                        maxVolume: boostedMaxVolume,
                                        referenceData,
                                        originalMeanVolume: meanVolume,
                                        originalMaxVolume: maxVolume,
                                        gainApplied: boostedMeanVolume - meanVolume,
                                        boostedAudioBuffer: boostedBuffer
                                    };
                                } else {
                                    console.log(`   ❌ Boosted audio still invalid: Mean ${boostedMeanVolume.toFixed(1)} dB, Max ${boostedMaxVolume.toFixed(1)} dB`);
                                }
                            }
                        } catch (revalidateError) {
                            console.log(`   ❌ Could not re-validate boosted audio: ${revalidateError.message}`);
                        } finally {
                            try {
                                fs.unlinkSync(boostedTempPath);
                            } catch (cleanupError) {
                                // Ignore cleanup errors
                            }
                        }
                    }
                    
                    // If we get here, boosting failed or boosted audio is still invalid
                    return {
                        isValid: false,
                        reason: 'too_quiet_boost_failed',
                        details: `Audio too quiet: mean volume ${meanVolume.toFixed(1)} dB < ${meanVolumeRange.min.toFixed(1)} dB (deck reference threshold), volume boosting failed`,
                        meanVolume,
                        maxVolume,
                        referenceData
                    };
                }
                
                if (meanVolume > meanVolumeRange.max) {
                    return {
                        isValid: false,
                        reason: 'too_loud',
                        details: `Audio too loud: mean volume ${meanVolume.toFixed(1)} dB > ${meanVolumeRange.max.toFixed(1)} dB (deck reference threshold)`,
                        meanVolume,
                        maxVolume,
                        referenceData
                    };
                }
                
                if (maxVolume > maxVolumeThreshold) {
                    return {
                        isValid: false,
                        reason: 'clipping_risk',
                        details: `Audio clipping risk: max volume ${maxVolume.toFixed(1)} dB > ${maxVolumeThreshold.toFixed(1)} dB (deck reference threshold)`,
                        meanVolume,
                        maxVolume,
                        referenceData
                    };
                }
                
                // Volume levels are good
                return {
                    isValid: true,
                    reason: 'volume_valid',
                    details: `Audio volume levels match deck reference: mean ${meanVolume.toFixed(1)} dB, max ${maxVolume.toFixed(1)} dB`,
                    meanVolume,
                    maxVolume,
                    referenceData
                };
            } else {
                // Fallback: if we can't parse volume info, assume it's okay
                console.log(`   ⚠️  Could not parse volume data, assuming valid`);
                return {
                    isValid: true,
                    reason: 'volume_unknown',
                    details: 'Volume analysis available but could not parse results - assuming valid'
                };
            }
            
        } catch (ffprobeError) {
            // ffprobe not available or failed - this is not critical
            console.log(`   ⚠️  ffprobe not available, skipping volume validation`);
            return {
                isValid: true,
                reason: 'volume_not_available',
                details: 'Volume validation not available (ffprobe not found) - assuming valid'
            };
        } finally {
            // Clean up temporary file
            try {
                fs.unlinkSync(tempFilePath);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
        }
        
    } catch (error) {
        console.log(`   ⚠️  Volume validation error: ${error.message}, assuming valid`);
        return {
            isValid: true,
            reason: 'volume_error',
            details: `Volume validation failed (${error.message}) - assuming valid`
        };
    }
}

/**
 * Check if a Korean word should be regenerated based on three criteria:
 * 1. GPT4o audio file is missing from plusaudio/audio directory
 * 2. Word is in the user-defined FORCE_REGENERATE_WORDS array  
 * 3. No audio or invalid audio format
 * 
 * PRESERVES: Both original deck audio (non-gpt4o) and valid GPT4o audio - these are NOT regenerated unless specifically requested!
 */
function shouldRegenerateAudio(koreanText, currentAudioField) {
    // Criterion 3: Check if word is in the force regenerate list
    if (FORCE_REGENERATE_WORDS.includes(koreanText.trim())) {
        return { shouldRegenerate: true, reason: 'in_force_regenerate_list' };
    }
    
    if (currentAudioField && currentAudioField.trim().length > 0) {
        // Extract filename from [sound:filename] format
        const soundMatch = currentAudioField.match(/\[sound:([^\]]+)\]/);
        if (soundMatch) {
            const audioFilename = soundMatch[1];
            
            // If audio doesn't end with "gpt4o.mp3", it's original good audio - DON'T regenerate
            if (!audioFilename.endsWith('gpt4o.mp3')) {
                return { shouldRegenerate: false, reason: 'original_good_audio' };
            }
            
            // Audio DOES end with "gpt4o.mp3" - this is our generated audio
            // Criterion 2: Check if corresponding audio file exists in plusaudio/audio
            const audioPath = `audio/${audioFilename}`;
            if (!fs.existsSync(audioPath)) {
                return { shouldRegenerate: true, reason: 'gpt4o_audio_file_missing' };
            }
            
            // gpt4o audio exists but is not in force regenerate list - keep it
            return { shouldRegenerate: false, reason: 'gpt4o_audio_exists_and_valid' };
        }
    }
    
    // No audio field or invalid format - should regenerate
    return { shouldRegenerate: true, reason: 'no_audio_or_invalid_format' };
}

/**
 * Compare transcription with expected text to determine if they match
 * Uses exact matching first, then Korean phonological equivalence for Korean text
 */
async function compareTranscription(transcription, expectedText) {
    // Normalize both strings for comparison
    const normalize = (text) => text.toLowerCase().trim().replace(/[^\w\s]/g, '');
    
    const normalizedTranscription = normalize(transcription);
    const normalizedExpected = normalize(expectedText);
    
    // First try exact match (fastest and most reliable)
    if (normalizedTranscription === normalizedExpected) {
        return { isValid: true, similarity: 1.0, reason: 'exact_match' };
    }
    
    // If exact match fails, check Korean phonological equivalence
    // This handles cases like 갖 vs 갓 (both sound like "gat")
    console.log(`🔤 Exact match failed, checking Korean phonological rules...`);
    const phonologyCheck = await checkKoreanPhonologicalEquivalence(expectedText, transcription);
    
    if (phonologyCheck.isPhonologicallyEquivalent) {
        return { 
            isValid: true, 
            similarity: 0.95, // Slightly lower than exact match but still very high
            reason: 'korean_phonological_match',
            phonologyExplanation: phonologyCheck.explanation,
            phonologyRules: phonologyCheck.rulesApplied
        };
    }
    
    // Both exact match and phonological equivalence failed
    return { 
        isValid: false, 
        similarity: 0, 
        reason: 'no_match',
        phonologyExplanation: phonologyCheck.explanation 
    };
}

/**
 * Validates an existing audio buffer by transcribing it blindly and checking if it matches expected text
 */
async function validateAudioBuffer(audioBuffer, expectedText, language = 'ko') {
    try {
        // Convert audio buffer to base64 for transcription
        const audioBase64 = audioBuffer.toString('base64');

        // Blind transcription using OpenAI (no expected text provided)
        console.log(`🔍 Transcribing audio blindly (language hint: ${language})`);
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
            console.error('❌ No tool call in transcription response');
            return { isValid: false, transcription: '', error: 'No transcription response' };
        }

        const transcriptionResult = JSON.parse(toolCall.function.arguments);
        console.log('🎯 Blind transcription result:', transcriptionResult);

        // Now compare the transcription with expected text
        const comparison = await compareTranscription(transcriptionResult.transcription, expectedText);
        
        console.log(`📊 Comparison: Expected "${expectedText}" vs Transcribed "${transcriptionResult.transcription}"`);
        console.log(`   Similarity: ${(comparison.similarity * 100).toFixed(1)}% | Valid: ${comparison.isValid} | Reason: ${comparison.reason}`);
        
        if (comparison.reason === 'korean_phonological_match') {
            console.log(`   🔊 Phonological match: ${comparison.phonologyExplanation}`);
            if (comparison.phonologyRules && comparison.phonologyRules.length > 0) {
                console.log(`   📜 Rules applied: ${comparison.phonologyRules.join(', ')}`);
            }
        } else if (comparison.reason === 'no_match' && comparison.phonologyExplanation) {
            console.log(`   🔊 Phonological analysis: ${comparison.phonologyExplanation}`);
        }

        return {
            isValid: comparison.isValid && transcriptionResult.transcription.trim().length > 0,
            transcription: transcriptionResult.transcription,
            confidence: transcriptionResult.confidence,
            languageDetected: transcriptionResult.language_detected,
            similarity: comparison.similarity,
            comparisonReason: comparison.reason,
            phonologyExplanation: comparison.phonologyExplanation || null,
            phonologyRules: comparison.phonologyRules || [],
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

            // Validate using blind transcription
            console.log(`🔍 Validating audio for "${text}" in ${language} (blind transcription)`);
            const validation = await validateAudioBuffer(tempBuffer, text, language);

            // Check validity
            if (validation.isValid) {
                isValidAudio = true;
                audioBuffer = tempBuffer;
                const matchType = validation.comparisonReason === 'exact_match' ? 'exact' : 'phonological';
                console.log(`✅ Audio validation successful (${matchType}) - transcribed: "${validation.transcription}" (${(validation.similarity * 100).toFixed(1)}% similarity)`);
                if (validation.phonologyExplanation) {
                    console.log(`   🔊 ${validation.phonologyExplanation}`);
                }
            } else {
                console.log(`❌ Audio validation failed - transcribed: "${validation.transcription}" (${(validation.similarity * 100).toFixed(1)}% similarity, reason: ${validation.comparisonReason})`);
                if (validation.phonologyExplanation) {
                    console.log(`   🔊 ${validation.phonologyExplanation}`);
                }
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

// Available voices for multi-voice fallback strategy
// If validation fails with one voice, we'll systematically try up to 5 different voices
// since some voices may be better at Korean pronunciation than others
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
        
        // Check if audio already exists and is valid size (unless forced to regenerate)
        if (fs.existsSync(filepath) && !FORCE_REGENERATE_WORDS.includes(koreanText.trim())) {
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
        } else if (fs.existsSync(filepath) && FORCE_REGENERATE_WORDS.includes(koreanText.trim())) {
            // Force regeneration - remove existing file first
            console.log(`🔄 Force regenerating: ${filename} (in FORCE_REGENERATE_WORDS list)`);
            fs.unlinkSync(filepath);
        }
        
        console.log(`🎵 Generating audio for: "${koreanText}" → ${filename}`);
        
        const maxAttemptsPerVoice = 2; // Attempts per voice
        const maxVoicesToTry = 5; // Maximum different voices to try
        let totalAttempts = 0;
        let lastVoice = null;
        
        // Get a shuffled list of voices to try systematically
        const shuffledVoices = [...voices].sort(() => Math.random() - 0.5);
        
        for (let voiceIndex = 0; voiceIndex < Math.min(maxVoicesToTry, shuffledVoices.length); voiceIndex++) {
            const currentVoice = shuffledVoices[voiceIndex];
            lastVoice = currentVoice;
            
            console.log(`\n🎭 Trying voice: ${currentVoice} (${voiceIndex + 1}/${Math.min(maxVoicesToTry, shuffledVoices.length)})`);
            
            for (let voiceAttempt = 1; voiceAttempt <= maxAttemptsPerVoice; voiceAttempt++) {
                totalAttempts++;
                console.log(`   🔄 Voice attempt ${voiceAttempt}/${maxAttemptsPerVoice} (total: ${totalAttempts})`);
            
                try {
                    const audioBuffer = await generateAudioWithGPT4oAudio(koreanText, currentVoice);
                
                // Check file size before validation
                if (audioBuffer.byteLength > 50000) {
                        console.log(`   ⚠️  Audio too large: ${audioBuffer.byteLength} bytes (> 50KB), trying next attempt...`);
                        if (voiceAttempt < maxAttemptsPerVoice) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                            continue; // Try again with same voice
                    } else {
                            console.log(`   ❌ Voice ${currentVoice} consistently produces oversized audio, trying next voice...`);
                            break; // Move to next voice
                        }
                    }
                    
                                        // Quick duration validation (before expensive GPT validation)
                    const durationValidation = validateAudioDuration(audioBuffer, koreanText);
                    if (!durationValidation.isValid) {
                        console.log(`   ❌ Audio duration validation failed: ${durationValidation.details}`);
                        if (voiceAttempt < maxAttemptsPerVoice) {
                            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                            continue; // Try again with same voice
                        } else {
                            console.log(`   ❌ Voice ${currentVoice} consistently produces invalid duration audio, trying next voice...`);
                            break; // Move to next voice
                        }
                    } else {
                        console.log(`   ✅ ${durationValidation.details}`);
                    }
                    
                    // Quick volume validation (before expensive GPT validation)
                    const volumeValidation = await validateAudioVolume(audioBuffer, koreanText);
                    if (!volumeValidation.isValid) {
                        console.log(`   ❌ Audio volume validation failed: ${volumeValidation.details}`);
                        if (voiceAttempt < maxAttemptsPerVoice) {
                            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                            continue; // Try again with same voice
                        } else {
                            console.log(`   ❌ Voice ${currentVoice} consistently produces invalid volume audio, trying next voice...`);
                            break; // Move to next voice
                        }
                    } else {
                        console.log(`   ✅ ${volumeValidation.details}`);
                        
                        // If volume was boosted, use the boosted audio buffer
                        if (volumeValidation.boostedAudioBuffer) {
                            audioBuffer = volumeValidation.boostedAudioBuffer;
                            console.log(`   🔊 Using volume-boosted audio (${audioBuffer.byteLength} bytes)`);
                        }
                    }
                    
                    // Validate the generated audio with GPT
                const validation = await validateAudioBuffer(audioBuffer, koreanText, 'ko');
                
                if (!validation.isValid) {
                        console.log(`   ❌ Audio validation failed: ${validation.error || 'Transcription mismatch'}`);
                        console.log(`      Expected: "${koreanText}"`);
                        console.log(`      Transcribed: "${validation.transcription}"`);
                        console.log(`      Similarity: ${(validation.similarity * 100).toFixed(1)}% | Reason: ${validation.comparisonReason}`);
                        if (validation.phonologyExplanation) {
                            console.log(`      🔊 Phonological analysis: ${validation.phonologyExplanation}`);
                        }
                        
                        if (voiceAttempt < maxAttemptsPerVoice) {
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait before retry
                            continue; // Try again with same voice
                    } else {
                            console.log(`   ❌ Voice ${currentVoice} failed validation ${maxAttemptsPerVoice} times, trying next voice...`);
                            break; // Move to next voice
                        }
                    }
                    
                    // SUCCESS! Audio passed validation
                    const matchType = validation.comparisonReason === 'exact_match' ? 'exact' : 'phonological';
                    console.log(`   ✅ Audio validation successful (${matchType}): "${validation.transcription}" (${(validation.similarity * 100).toFixed(1)}% similarity)`);
                    if (validation.phonologyExplanation) {
                        console.log(`      🔊 ${validation.phonologyExplanation}`);
                    }
                
                fs.writeFileSync(filepath, audioBuffer);
                console.log(`💾 Audio saved: ${filepath} (${audioBuffer.byteLength} bytes)`);
                    console.log(`🎭 Success with voice: ${currentVoice} after ${totalAttempts} total attempts`);
                
                return [{
                    filename,
                    filepath,
                    status: 'generated',
                    method: 'gpt-4o-audio-preview',
                        voice: currentVoice,
                    koreanText,
                    fileSize: audioBuffer.byteLength,
                        attempts: totalAttempts,
                        voicesAttempted: voiceIndex + 1,
                        durationValidation: {
                            isValid: durationValidation.isValid,
                            reason: durationValidation.reason,
                            details: durationValidation.details
                        },
                        volumeValidation: {
                            isValid: volumeValidation.isValid,
                            reason: volumeValidation.reason,
                            details: volumeValidation.details,
                            meanVolume: volumeValidation.meanVolume || null,
                            maxVolume: volumeValidation.maxVolume || null,
                            referenceSource: volumeValidation.referenceData?.source || null,
                            volumeBoosted: !!volumeValidation.boostedAudioBuffer,
                            originalMeanVolume: volumeValidation.originalMeanVolume || null,
                            gainApplied: volumeValidation.gainApplied || null
                        },
                    validation: {
                        isValid: validation.isValid,
                            transcription: validation.transcription,
                            confidence: validation.confidence,
                            languageDetected: validation.languageDetected,
                            similarity: validation.similarity,
                            comparisonReason: validation.comparisonReason,
                            phonologyExplanation: validation.phonologyExplanation,
                            phonologyRules: validation.phonologyRules
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
                
                    console.error(`   ❌ Voice attempt failed: ${error.message}`);
                    
                    if (voiceAttempt >= maxAttemptsPerVoice) {
                        console.log(`   ❌ Voice ${currentVoice} failed ${maxAttemptsPerVoice} times, trying next voice...`);
                        break; // Move to next voice
                    }
                    
                    // Wait before retry with same voice
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }
            }
        }
        
        // If we get here, all voices failed
        console.log(`❌ All ${Math.min(maxVoicesToTry, shuffledVoices.length)} voices failed after ${totalAttempts} total attempts`);
                    return [{
                        filename: null,
                        filepath: null,
                        status: 'error',
                        method: 'gpt-4o-audio-preview',
            voice: lastVoice,
            error: `Failed with all ${Math.min(maxVoicesToTry, shuffledVoices.length)} voices after ${totalAttempts} attempts`,
                        koreanText,
            attempts: totalAttempts,
            voicesAttempted: Math.min(maxVoicesToTry, shuffledVoices.length),
            durationValidation: {
                            isValid: false,
                reason: 'all_voices_failed',
                details: 'No voice could produce valid duration audio'
            },
            volumeValidation: {
                isValid: false,
                reason: 'all_voices_failed',
                details: 'No voice could produce valid volume audio',
                meanVolume: null,
                maxVolume: null,
                referenceSource: null,
                volumeBoosted: false,
                originalMeanVolume: null,
                gainApplied: null
            },
            validation: {
                isValid: false,
                transcription: '',
                confidence: 'unknown',
                languageDetected: 'unknown',
                similarity: 0,
                comparisonReason: 'all_voices_failed',
                phonologyExplanation: null,
                phonologyRules: []
            }
        }];
        
    } catch (error) {
        console.error(`❌ Failed to generate audio for "${koreanText}":`, error.message);
        return [{
            filename: null,
            filepath: null,
            status: 'error',
            method: 'gpt-4o-audio-preview',
            voice: lastVoice || 'unknown',
            error: error.message,
            koreanText,
            attempts: totalAttempts || 0,
            voicesAttempted: 0,
            durationValidation: {
                isValid: false,
                reason: 'general_error',
                details: 'Duration validation not performed due to error'
            },
            volumeValidation: {
                isValid: false,
                reason: 'general_error',
                details: 'Volume validation not performed due to error',
                meanVolume: null,
                maxVolume: null,
                referenceSource: null,
                volumeBoosted: false,
                originalMeanVolume: null,
                gainApplied: null
            },
            validation: {
                isValid: false,
                transcription: '',
                confidence: 'unknown',
                languageDetected: 'unknown',
                similarity: 0,
                comparisonReason: 'general_error',
                phonologyExplanation: null,
                phonologyRules: []
            }
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

    // Now let's generate audio for notes that need regeneration
    console.log('\n=== 🎵 AUDIO REGENERATION PHASE ===');
    console.log(`🎯 Target: Regenerate audio based on smart criteria`);
    console.log(`📁 Audio will be saved to: ./audio/`);
    console.log(`🎤 Using GPT-4o-audio-preview with o4-mini-2025-04-16 Korean phonological validation`);
    console.log(`📏 Audio validation & volume boosting: Uses deck analysis + ffmpeg to normalize quiet audio`);
    console.log(`🎭 Multi-voice fallback: Will try up to 5 different voices per word if validation fails`);
    console.log(`🔍 Checking all notes for regeneration needs...`);
    console.log(`💾 Progress will be saved continuously to avoid data loss`);
    console.log(`⚠️  Will stop immediately on rate limit or billing errors`);
    
    // Analyze reference audio to establish volume baselines before starting generation
    console.log('');
    await analyzeReferenceAudioVolumes();
    
    console.log(`\n🎯 REGENERATION CRITERIA:`);
    console.log(`   1. GPT4o audio file missing from plusaudio/audio directory`);
    console.log(`   2. Word in FORCE_REGENERATE_WORDS array (${FORCE_REGENERATE_WORDS.length} words)`);
    console.log(`   3. No audio or invalid audio format`);
    console.log(`   ✅ PRESERVED: Original deck audio (non-gpt4o) will NOT be regenerated`);
    console.log(`   ✅ PRESERVED: Valid GPT4o audio will NOT be regenerated (unless in force list)`);
    if (FORCE_REGENERATE_WORDS.length > 0) {
        console.log(`      Force regenerate: ${FORCE_REGENERATE_WORDS.join(', ')}`);
    }
    
    // We need to re-parse to get the full dataset for audio generation
    await generateAudioForNotesWithoutAudio(); // Generate for notes that need regeneration

}).catch(error => {
    console.error('Error in main process:', error);
});

/**
 * Re-parse the deck and generate audio for notes that need regeneration
 * Based on three criteria:
 * 1. GPT4o audio file is missing from plusaudio/audio directory
 * 2. Word is in the user-defined FORCE_REGENERATE_WORDS array
 * 3. No audio or invalid audio format
 * 
 * PRESERVES: Original deck audio (non-gpt4o files) and valid GPT4o audio - these are NOT regenerated unless specifically requested
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

                                // Get ALL notes to check which ones need regeneration
                                const query = `SELECT id, flds FROM notes ORDER BY id`;
                                
                                const allNotes = maxCount ? 
                                    db.prepare(query + ' LIMIT ?').all(maxCount) : 
                                    db.prepare(query).all();

                                console.log(`📊 Analyzing ${allNotes.length} notes for audio regeneration needs...`);
                                
                                // Filter notes that need regeneration
                                const notesToRegenerate = [];
                                let skipReasons = {
                                    'original_good_audio': 0,
                                    'gpt4o_audio_exists_and_valid': 0,
                                    'in_force_regenerate_list': 0,
                                    'gpt4o_audio_file_missing': 0,
                                    'no_audio_or_invalid_format': 0
                                };
                                
                                for (const note of allNotes) {
                                    const fields = note.flds.split('\x1f');
                                    const koreanText = fields[0]?.trim(); // Field 0 contains Korean
                                    const audioField = fields[3]?.trim(); // Field 3 contains audio
                                    
                                    if (koreanText && koreanText.length > 0) {
                                        const regenerateCheck = shouldRegenerateAudio(koreanText, audioField);
                                        skipReasons[regenerateCheck.reason]++;
                                        
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

                                console.log(`🎯 Analysis Results:`);
                                console.log(`   Total notes: ${allNotes.length}`);
                                console.log(`   ✅ Original good audio (skip): ${skipReasons['original_good_audio']}`);
                                console.log(`   ✅ GPT4o audio valid (skip): ${skipReasons['gpt4o_audio_exists_and_valid']}`);
                                console.log(`   🔄 Force regenerate: ${skipReasons['in_force_regenerate_list']}`);
                                console.log(`   ❌ GPT4o missing files: ${skipReasons['gpt4o_audio_file_missing']}`);
                                console.log(`   🚫 No/invalid audio: ${skipReasons['no_audio_or_invalid_format']}`);
                                console.log(`   🎵 TOTAL TO REGENERATE: ${notesToRegenerate.length}`);
                                
                                if (maxCount && notesToRegenerate.length > maxCount) {
                                    console.log(`📝 Processing first ${maxCount} for testing`);
                                } else if (notesToRegenerate.length > 0) {
                                    console.log(`🚀 Processing ${notesToRegenerate.length} notes that need regeneration!`);
                                } else {
                                    console.log(`🎉 No notes need regeneration! All audio is up to date.`);
                                    resolve([]);
                                    return;
                                }

                                const audioResults = [];
                                let processedCount = 0;
                                let generatedCount = 0;
                                let skippedCount = 0;
                                let errorCount = 0;
                                const startTime = new Date();

                                for (const note of notesToRegenerate) {
                                    const koreanText = note.koreanText;

                                    processedCount++;
                                    
                                    // Progress reporting every 50 notes
                                    if (processedCount % 50 === 0 || processedCount === 1) {
                                        const elapsed = (new Date() - startTime) / 1000;
                                        const rate = processedCount / elapsed * 60; // notes per minute
                                        const remaining = notesToRegenerate.length - processedCount;
                                        const eta = remaining / rate; // minutes
                                        
                                        console.log(`\n📊 PROGRESS UPDATE:`);
                                        console.log(`   Processed: ${processedCount}/${notesToRegenerate.length} (${(processedCount/notesToRegenerate.length*100).toFixed(1)}%)`);
                                        console.log(`   Generated: ${generatedCount} | Skipped: ${skippedCount} | Errors: ${errorCount}`);
                                        console.log(`   Rate: ${rate.toFixed(1)} notes/min | ETA: ${eta.toFixed(0)} minutes`);
                                    }
                                    
                                    console.log(`\n--- Note ${processedCount}/${notesToRegenerate.length}: "${koreanText}" (${note.regenerateReason}) ---`);

                                        try {
                                            const results = await generateKoreanAudioForNote(koreanText, note.id, processedCount - 1);
                                            
                                            // Add each result to the results array
                                            for (const result of results) {
                                                audioResults.push({
                                                    noteId: note.id,
                                                regenerateReason: note.regenerateReason,
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
                                                totalNotes: notesToRegenerate.length,
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
                                        if (wasGenerated && processedCount < notesToRegenerate.length) {
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
                                                totalNotes: notesToRegenerate.length,
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
                                                regenerateReason: note.regenerateReason,
                                filename: null,
                                filepath: null,
                                status: 'error',
                                method: 'gpt-4o-audio-preview',
                                                voice: 'unknown',
                                error: error.message,
                                koreanText,
                                durationValidation: {
                                    isValid: false,
                                    reason: 'processing_error',
                                    details: 'Duration validation not performed due to processing error'
                                },
                                volumeValidation: {
                                    isValid: false,
                                    reason: 'processing_error',
                                    details: 'Volume validation not performed due to processing error',
                                    meanVolume: null,
                                    maxVolume: null,
                                    referenceSource: null,
                                    volumeBoosted: false,
                                    originalMeanVolume: null,
                                    gainApplied: null
                                },
                                                validation: {
                                                    isValid: false,
                                                    transcription: '',
                                                    confidence: 'unknown',
                                                    languageDetected: 'unknown',
                                                    similarity: 0,
                                                    comparisonReason: 'processing_error',
                                                    phonologyExplanation: null,
                                                    phonologyRules: []
                                                }
                                            });
                                    }
                                }

                                db.close();

                                const endTime = new Date();
                                const totalTime = (endTime - startTime) / 1000; // seconds
                                
                                console.log('\n=== 🎵 AUDIO REGENERATION COMPLETE ===');
                                console.log(`📊 FINAL STATISTICS:`);
                                console.log(`   Total processed: ${processedCount}/${notesToRegenerate.length}`);
                                console.log(`   ✅ Generated: ${generatedCount} new audio files`);
                                console.log(`   ♻️  Already existed: ${audioResults.filter(r => r.status === 'exists').length}`);
                                console.log(`   ⚠️  Skipped: ${skippedCount}`);
                                console.log(`   ❌ Failed: ${errorCount}`);
                                console.log(`   ⏱️  Total time: ${(totalTime/60).toFixed(1)} minutes`);
                                console.log(`   📈 Rate: ${(processedCount / totalTime * 60).toFixed(1)} notes/minute`);
                                
                                // Show breakdown by regeneration reason
                                console.log(`\n📋 REGENERATION BREAKDOWN:`);
                                const reasonStats = {};
                                audioResults.forEach(result => {
                                    const reason = result.regenerateReason || 'unknown';
                                    reasonStats[reason] = (reasonStats[reason] || 0) + 1;
                                });
                                Object.entries(reasonStats).forEach(([reason, count]) => {
                                    console.log(`   ${reason}: ${count}`);
                                });

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

