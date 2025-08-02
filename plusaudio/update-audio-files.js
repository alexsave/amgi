// Update audio files in existing .apkg file with newly generated audio
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const Database = require('better-sqlite3');

const inputFile = 'Korean Vocabulary by Evita (with Audio).apkg';
const outputFile = 'Korean Vocabulary by Evita (with Audio Updated).apkg';
const audioDir = 'audio';
const progressFile = 'audio_generation_results.json';

console.log('=== UPDATING AUDIO FILES IN KOREAN DECK ===');
console.log(`Input: ${inputFile}`);
console.log(`Output: ${outputFile}`);
console.log('');

// Load audio generation results to see which files have been updated
let audioResults = null;
try {
    const resultsContent = fs.readFileSync(progressFile, 'utf8');
    audioResults = JSON.parse(resultsContent);
    console.log(`📊 Audio generation results loaded:`);
    console.log(`   Total processed: ${audioResults.processed}`);
    console.log(`   Available results: ${audioResults.results.length}`);
} catch (error) {
    console.error('❌ Error loading audio results file:', error.message);
    process.exit(1);
}

// Create mapping of Korean text to updated audio files with unique names
const updatedAudioMapping = new Map();
let generatedCount = 0;
let forcedCount = 0;

// Generate a timestamp for unique filenames
const updateTimestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // 2024-01-15T10-30-45

audioResults.results.forEach(result => {
    if (result.status === 'generated') {
        // Create unique filename by adding timestamp before the extension
        const originalFilename = result.filename;
        const extensionIndex = originalFilename.lastIndexOf('.');
        const baseName = originalFilename.substring(0, extensionIndex);
        const extension = originalFilename.substring(extensionIndex);
        const uniqueFilename = `${baseName}_${updateTimestamp}${extension}`;
        
        updatedAudioMapping.set(result.koreanText.trim(), {
            filename: uniqueFilename,  // The new unique filename
            originalFilename: originalFilename,  // The original filename (대사관_gpt4o.mp3)
            originalFilepath: result.filepath,  // The original file path (audio/대사관_gpt4o.mp3)
            koreanText: result.koreanText,
            reason: result.regenerateReason
        });
        
        if (result.regenerateReason === 'in_force_regenerate_list') {
            forcedCount++;
        } else {
            generatedCount++;
        }
    }
});

console.log(`🎵 Updated audio files available for ${updatedAudioMapping.size} words`);
console.log(`   Generated: ${generatedCount}`);
console.log(`   Forced regeneration: ${forcedCount}`);
console.log('');

async function updateAudioFiles() {
    return new Promise((resolve, reject) => {
        console.log('📖 Opening input .apkg file...');
        
        yauzl.open(inputFile, { lazyEntries: true }, async (err, sourceZipfile) => {
            if (err) {
                reject(err);
                return;
            }

            // Create new zip file for output
            const outputZip = new yazl.ZipFile();
            const outputStream = fs.createWriteStream(outputFile);
            outputZip.outputStream.pipe(outputStream);
            
            let collectionProcessed = false;
            let mediaProcessed = false;
            let audioFilesToUpdate = new Set(); // Track which audio files need updating
            let existingMediaMapping = {}; // Current media ID to filename mapping
            let mediaIdToReplace = new Map(); // Track which media IDs need new audio files
            
            sourceZipfile.readEntry();
            
            sourceZipfile.on("entry", async (entry) => {
                console.log(`Processing: ${entry.fileName}`);
                
                if (entry.fileName.endsWith('/')) {
                    // Directory entry, skip
                    sourceZipfile.readEntry();
                    return;
                }
                
                if (entry.fileName === 'collection.anki21') {
                    // Process the main database
                    sourceZipfile.openReadStream(entry, async (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        const chunks = [];
                        readStream.on('data', chunk => chunks.push(chunk));
                        readStream.on('end', async () => {
                            try {
                                console.log('🔄 Processing collection database...');
                                const buffer = Buffer.concat(chunks);
                                
                                // Create in-memory database
                                const db = new Database(buffer);
                                
                                // Find notes that need audio updates
                                console.log('🎵 Checking for notes with updated audio...');
                                let updatedCount = 0;
                                
                                const selectStmt = db.prepare("SELECT id, flds FROM notes");
                                const updateStmt = db.prepare("UPDATE notes SET flds = ? WHERE id = ?");
                                
                                const notes = selectStmt.all();
                                console.log(`📝 Checking ${notes.length} notes for audio updates...`);
                                
                                for (const note of notes) {
                                    const fields = note.flds.split('\x1f');
                                    const koreanText = fields[0]?.trim(); // Field 0 contains Korean text
                                    const currentAudioField = fields[3] || ''; // Field 3 contains audio
                                    
                                    if (koreanText && updatedAudioMapping.has(koreanText)) {
                                        const audioInfo = updatedAudioMapping.get(koreanText);
                                        
                                        // Extract current audio filename for replacement
                                        const currentSoundMatch = currentAudioField.match(/\[sound:([^\]]+)\]/);
                                        let currentAudioFilename = null;
                                        if (currentSoundMatch) {
                                            currentAudioFilename = currentSoundMatch[1];
                                        }
                                        
                                        // Create new audio reference
                                        const newAudioTag = `[sound:${audioInfo.filename}]`;
                                        
                                        // Update the audio field
                                        fields[3] = newAudioTag;
                                        const updatedFields = fields.join('\x1f');
                                        
                                        // Update the note
                                        updateStmt.run(updatedFields, note.id);
                                        
                                                                // Track this audio file for replacement
                        audioFilesToUpdate.add({
                            filename: audioInfo.filename,  // The new unique filename
                            originalFilepath: audioInfo.originalFilepath,  // Source file path
                            koreanText: audioInfo.koreanText,
                            reason: audioInfo.reason,
                            oldFilename: currentAudioFilename
                        });
                                        
                                        updatedCount++;
                                        console.log(`  Updated "${koreanText}" → ${audioInfo.filename} (${audioInfo.reason})`);
                                    }
                                }
                                
                                console.log(`✅ Updated ${updatedCount} notes with new audio references`);
                                console.log(`📁 Audio files to update: ${audioFilesToUpdate.size}`);
                                
                                // Serialize the updated database
                                const serialized = db.serialize();
                                db.close();
                                
                                // Add to output zip
                                outputZip.addBuffer(Buffer.from(serialized), entry.fileName);
                                collectionProcessed = true;
                                
                                sourceZipfile.readEntry();
                                
                            } catch (error) {
                                console.error('❌ Error processing collection:', error);
                                reject(error);
                            }
                        });
                    });
                } else if (entry.fileName === 'collection.anki2') {
                    // Copy collection.anki2 as-is
                    sourceZipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        outputZip.addReadStream(readStream, entry.fileName);
                        sourceZipfile.readEntry();
                    });
                } else if (entry.fileName === 'media') {
                    // Process media file (JSON mapping)
                    sourceZipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        const chunks = [];
                        readStream.on('data', chunk => chunks.push(chunk));
                        readStream.on('end', () => {
                            console.log('📁 Processing media mapping...');
                            
                            // Parse existing media mapping
                            try {
                                const existingContent = Buffer.concat(chunks).toString();
                                if (existingContent.trim()) {
                                    existingMediaMapping = JSON.parse(existingContent);
                                }
                            } catch (error) {
                                console.log('📁 Error parsing media mapping, creating new one');
                                existingMediaMapping = {};
                            }
                            
                            console.log(`📁 Found ${Object.keys(existingMediaMapping).length} existing media files`);
                            
                            // Find media IDs that correspond to files we're updating
                            for (const [mediaId, filename] of Object.entries(existingMediaMapping)) {
                                                            for (const audioFile of audioFilesToUpdate) {
                                if (filename === audioFile.filename) {
                                    // This media ID needs to be replaced with updated audio
                                    mediaIdToReplace.set(mediaId, audioFile);
                                    console.log(`  Will replace media ${mediaId}: ${filename} (${audioFile.koreanText})`);
                                    break;
                                }
                            }
                            }
                            
                            // Find the next available media ID for any completely new files
                            const existingIds = Object.keys(existingMediaMapping).map(id => parseInt(id));
                            let nextMediaId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
                            
                            // Add any new audio files that don't have existing media IDs
                            const updatedMediaMapping = { ...existingMediaMapping };
                            for (const audioFile of audioFilesToUpdate) {
                                // Check if this filename already exists in media mapping
                                const existingMediaId = Object.entries(existingMediaMapping)
                                    .find(([id, filename]) => filename === audioFile.filename)?.[0];
                                
                                if (!existingMediaId) {
                                    // This is a completely new audio file, add it
                                    updatedMediaMapping[nextMediaId] = audioFile.filename;
                                    mediaIdToReplace.set(nextMediaId.toString(), audioFile);
                                    console.log(`  Will add new media ${nextMediaId}: ${audioFile.filename} (${audioFile.koreanText})`);
                                    nextMediaId++;
                                }
                            }
                            
                            const mediaBuffer = Buffer.from(JSON.stringify(updatedMediaMapping));
                            outputZip.addBuffer(mediaBuffer, 'media');
                            mediaProcessed = true;
                            
                            console.log(`📁 Media mapping processed: ${Object.keys(existingMediaMapping).length} existing + ${audioFilesToUpdate.size} updates = ${Object.keys(updatedMediaMapping).length} total`);
                            sourceZipfile.readEntry();
                        });
                    });
                } else if (/^\d+$/.test(entry.fileName)) {
                    // Existing media file - check if we need to replace it
                    const mediaId = entry.fileName;
                    const audioToReplace = mediaIdToReplace.get(mediaId);
                    
                    if (audioToReplace) {
                        // Replace this media file with updated audio
                        // Use the original filepath to read the audio file
                        const audioPath = audioToReplace.originalFilepath;
                        if (fs.existsSync(audioPath)) {
                            console.log(`  Replacing media ${mediaId} with updated audio: ${audioToReplace.filename} (${audioToReplace.koreanText})`);
                            console.log(`    Source: ${audioPath} → Target: ${audioToReplace.filename}`);
                            outputZip.addFile(audioPath, mediaId);
                        } else {
                            console.log(`  ⚠️  Audio file not found: ${audioPath}, keeping original`);
                            // Keep original file
                            sourceZipfile.openReadStream(entry, (err, readStream) => {
                                if (err) {
                                    reject(err);
                                    return;
                                }
                                outputZip.addReadStream(readStream, entry.fileName);
                                sourceZipfile.readEntry();
                            });
                            return;
                        }
                    } else {
                        // Keep existing media file
                        sourceZipfile.openReadStream(entry, (err, readStream) => {
                            if (err) {
                                reject(err);
                                return;
                            }
                            outputZip.addReadStream(readStream, entry.fileName);
                            sourceZipfile.readEntry();
                        });
                        return;
                    }
                    
                    sourceZipfile.readEntry();
                } else {
                    // Other files, copy as-is
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
            
            sourceZipfile.on("end", async () => {
                console.log('📦 Finalizing updated deck...');
                
                // Add any completely new audio files that weren't replacements
                let newAudioCount = 0;
                for (const [mediaId, audioFile] of mediaIdToReplace) {
                    // Use the original filepath for the source audio
                    const audioPath = audioFile.originalFilepath;
                    if (fs.existsSync(audioPath) && !fs.existsSync(path.join('temp_media', mediaId))) {
                        // This is a new file, not a replacement
                        const stats = fs.statSync(audioPath);
                        if (stats.size <= 50000) { // 50KB limit
                            console.log(`  Adding new audio: ${audioFile.filename} → ${mediaId} (${audioFile.koreanText})`);
                            console.log(`    Source: ${audioPath}`);
                            outputZip.addFile(audioPath, mediaId);
                            newAudioCount++;
                        } else {
                            console.log(`  ⚠️  Skipping oversized audio: ${audioFile.filename} (${stats.size} bytes > 50KB)`);
                        }
                    }
                }
                
                console.log(`🎵 Updated ${mediaIdToReplace.size} audio files (${newAudioCount} new)`);
                
                // Finalize the zip
                outputZip.end();
                
                outputStream.on('close', () => {
                    const stats = fs.statSync(outputFile);
                    console.log('');
                    console.log('=== ✅ AUDIO FILES UPDATED SUCCESSFULLY ===');
                    console.log(`📂 Output file: ${outputFile}`);
                    console.log(`📏 File size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
                    console.log(`🎵 Updated audio files: ${updatedAudioMapping.size}`);
                    console.log(`   Generated: ${generatedCount}`);
                    console.log(`   Force regenerated: ${forcedCount}`);
                    console.log(`   Unique timestamp: ${updateTimestamp}`);
                    console.log('');
                    console.log('🎉 Your Korean deck has been updated with new audio!');
                    console.log('   ✅ Audio files use unique names to force Anki import (timestamp added)');
                    console.log('   ✅ Notes updated to reference the new audio files');
                    console.log('   ✅ Import will add new audio alongside existing files');
                    console.log('   ✅ All your review history and deck structure are preserved');
                    console.log(`   ✅ Original file (${inputFile}) is preserved safely`);
                    console.log('');
                    console.log('📝 IMPORTANT: After importing, you can manually clean up old audio files in Anki:');
                    console.log('   Tools → Check Media → Delete Unused');
                    
                    resolve();
                });
            });
        });
    });
}

// Run the process
updateAudioFiles().catch(error => {
    console.error('❌ Error updating audio files:', error);
    process.exit(1);
});