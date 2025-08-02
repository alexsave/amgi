// Create augmented .apkg file with embedded audio
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const Database = require('better-sqlite3');

const sourceFile = 'Korean Vocabulary by Evita.apkg';
const outputFile = 'Korean Vocabulary by Evita (with Audio).apkg';
const audioDir = 'audio';
const progressFile = 'audio_generation_progress.json';

console.log('=== CREATING AUGMENTED KOREAN DECK WITH AUDIO ===');
console.log(`Source: ${sourceFile}`);
console.log(`Output: ${outputFile}`);
console.log('');

// Load progress data to see which cards have audio
let progressData = null;
try {
    const progressContent = fs.readFileSync(progressFile, 'utf8');
    progressData = JSON.parse(progressContent);
    console.log(`📊 Audio generation results loaded:`);
    console.log(`   Total processed: ${progressData.processed}/${progressData.totalNotes}`);
    console.log(`   Generated files: ${progressData.generated}`);
    console.log(`   Results available: ${progressData.results.length}`);
} catch (error) {
    console.error('❌ Error loading progress file:', error.message);
    process.exit(1);
}

// Create mapping of noteId to audio file info
const audioMapping = new Map();
progressData.results.forEach(result => {
    if (result.status === 'generated' || result.status === 'exists') {
        audioMapping.set(result.noteId, {
            filename: result.filename,
            filepath: result.filepath,
            koreanText: result.koreanText
        });
    }
});

console.log(`🎵 Audio files available for ${audioMapping.size} notes`);
console.log('');

async function createAugmentedDeck() {
    return new Promise((resolve, reject) => {
        console.log('📖 Opening source .apkg file...');
        
        yauzl.open(sourceFile, { lazyEntries: true }, async (err, sourceZipfile) => {
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
            let audioFilesToAdd = new Set(); // Track which audio files we need to add
            let completeMediaMapping = {}; // Final media ID to filename mapping
            
            sourceZipfile.readEntry();
            
            sourceZipfile.on("entry", async (entry) => {
                console.log(`Processing: ${entry.fileName}`);
                
                if (entry.fileName.endsWith('/')) {
                    // Directory entry, skip
                    sourceZipfile.readEntry();
                    return;
                }
                
                if (entry.fileName === 'collection.anki21') {
                    // Process the main database - we'll only use anki21 format
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
                                
                                // Update notes with audio references based on field structure analysis
                                console.log('🎵 Adding audio references to notes...');
                                let updatedCount = 0;
                                
                                // Generate new note IDs and GUIDs to avoid conflicts with existing collection
                                let idCounter = Date.now() * 1000; // Start with current timestamp in microseconds
                                const generateNewId = () => ++idCounter; // Increment to ensure uniqueness
                                const generateNewGuid = () => {
                                    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                                    let result = '';
                                    for (let i = 0; i < 10; i++) {
                                        result += chars.charAt(Math.floor(Math.random() * chars.length));
                                    }
                                    return result;
                                };
                                const noteIdMapping = new Map(); // old ID -> new ID
                                
                                const updateStmt = db.prepare("UPDATE notes SET flds = ?, id = ?, guid = ? WHERE id = ?");
                                const updateCardsStmt = db.prepare("UPDATE cards SET nid = ? WHERE nid = ?");
                                const selectStmt = db.prepare("SELECT id, flds, guid FROM notes");
                                
                                const notes = selectStmt.all();
                                console.log(`📝 Processing ${notes.length} notes with new IDs to avoid collection conflicts...`);
                                
                                for (const note of notes) {
                                    // Generate new ID and GUID for this note to avoid collection conflicts
                                    const oldId = note.id;
                                    const newId = generateNewId();
                                    const newGuid = generateNewGuid();
                                    noteIdMapping.set(oldId, newId);
                                    
                                    const audioInfo = audioMapping.get(note.id);
                                    const fields = note.flds.split('\x1f');
                                    let updatedFields = note.flds; // default to original
                                    
                                    if (audioInfo) {
                                        // Use card number (field 4) instead of Korean text for filename
                                        const cardNumber = fields[4] || 'unknown';
                                        const safeFilename = `${cardNumber}_gpt4o.mp3`;
                                        
                                        // Based on analysis: Field 3 contains audio references like [sound:filename.mp3]
                                        // Replace existing audio with our new generated audio, or add if missing
                                        const audioTag = `[sound:${safeFilename}]`;
                                        const hadExistingAudio = fields[3] && fields[3].includes('[sound:');
                                        
                                        // Set the new audio reference
                                        fields[3] = audioTag;
                                        updatedFields = fields.join('\x1f');
                                        
                                        // Track this audio file for later addition (map old filename to new filename)
                                        audioFilesToAdd.add({
                                            oldFilename: audioInfo.filename,
                                            newFilename: safeFilename,
                                            cardNumber,
                                            koreanText: audioInfo.koreanText
                                        });
                                        updatedCount++;
                                        
                                        if (hadExistingAudio) {
                                            console.log(`  Replaced existing audio for "${audioInfo.koreanText}" with ${safeFilename}`);
                                        }
                                    }
                                    
                                    // Update the note with new ID, GUID (and updated fields if applicable)
                                    updateStmt.run(updatedFields, newId, newGuid, oldId);
                                    
                                    // Update all cards that reference this note
                                    updateCardsStmt.run(newId, oldId);
                                }
                                
                                console.log(`✅ Generated new IDs for all ${notes.length} notes to avoid collection conflicts`);
                                console.log(`🎵 Updated ${updatedCount} notes with audio references`);
                                console.log(`📁 New media files to add: ${audioFilesToAdd.size}`);
                                
                                // Generate completely new deck ID to force separate import
                                console.log('📝 Creating completely new deck with unique ID...');
                                const deckStmt = db.prepare("SELECT decks FROM col");
                                const deckData = deckStmt.get();
                                if (deckData && deckData.decks) {
                                    const decks = JSON.parse(deckData.decks);
                                    const newDecks = {};
                                    
                                    for (const [deckId, deck] of Object.entries(decks)) {
                                        if (deck.name && deck.name.includes('Korean Vocabulary')) {
                                            // Generate completely unique deck ID using timestamp + random
                                            const newDeckId = Date.now() + Math.floor(Math.random() * 100000);
                                            const oldName = deck.name;
                                            const newDeck = {
                                                ...deck,
                                                name: 'Korean Vocabulary by Evita (with Audio)',
                                                id: newDeckId,
                                                // Ensure other deck properties are unique
                                                mod: Date.now(),
                                                conf: 1  // Use default config
                                            };
                                            newDecks[newDeckId] = newDeck;
                                            console.log(`  Created new deck: "${oldName}" → "${newDeck.name}" (ID: ${deckId} → ${newDeckId})`);
                                            
                                            // CRITICAL: Update all cards to reference the new deck ID
                                            console.log('  Updating all cards to reference new deck ID...');
                                            const updateCardDeckStmt = db.prepare("UPDATE cards SET did = ? WHERE did = ?");
                                            const updatedCards = updateCardDeckStmt.run(newDeckId, parseInt(deckId));
                                            console.log(`  Updated ${updatedCards.changes} cards to new deck ID ${newDeckId}`);
                                        } else {
                                            newDecks[deckId] = deck;
                                        }
                                    }
                                    const updateDeckStmt = db.prepare("UPDATE col SET decks = ?");
                                    updateDeckStmt.run(JSON.stringify(newDecks));
                                }
                                
                                // Update note types with new IDs to avoid conflicts
                                console.log('📝 Updating note types with new IDs...');
                                const modelsStmt = db.prepare("SELECT models FROM col");
                                const modelsData = modelsStmt.get();
                                const modelIdMapping = new Map(); // old model ID -> new model ID
                                
                                if (modelsData && modelsData.models) {
                                    const models = JSON.parse(modelsData.models);
                                    const newModels = {};
                                    
                                    for (const [modelId, model] of Object.entries(models)) {
                                        // Generate new model ID and update name to avoid conflicts
                                        const newModelId = generateNewId();
                                        const newModel = {
                                            ...model,
                                            id: newModelId,
                                            name: model.name + ' (Audio)'
                                        };
                                        
                                        modelIdMapping.set(parseInt(modelId), newModelId);
                                        newModels[newModelId] = newModel;
                                        console.log(`  Updated note type: "${model.name}" → "${newModel.name}" (ID: ${modelId} → ${newModelId})`);
                                    }
                                    
                                    // Update the database with new note type information
                                    const updateModelsStmt = db.prepare("UPDATE col SET models = ?");
                                    updateModelsStmt.run(JSON.stringify(newModels));
                                    
                                    // Update all notes to reference the new model IDs
                                    console.log('📝 Updating notes to reference new note type IDs...');
                                    for (const [oldModelId, newModelId] of modelIdMapping) {
                                        const updateNoteModelStmt = db.prepare("UPDATE notes SET mid = ? WHERE mid = ?");
                                        const updatedRows = updateNoteModelStmt.run(newModelId, oldModelId);
                                        console.log(`  Updated ${updatedRows.changes} notes from model ${oldModelId} to ${newModelId}`);
                                    }
                                }
                                
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
                    // Skip collection.anki2 - we only want the updated collection.anki21
                    console.log('Skipping collection.anki2 - using updated collection.anki21 instead');
                    sourceZipfile.readEntry();
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
                            console.log('📁 Processing original media mapping...');
                            
                            // Parse existing media mapping
                            let existingMedia = {};
                            try {
                                const existingContent = Buffer.concat(chunks).toString();
                                if (existingContent.trim()) {
                                    existingMedia = JSON.parse(existingContent);
                                }
                            } catch (error) {
                                console.log('📁 No existing media or parse error, starting fresh');
                            }
                            
                            console.log(`📁 Found ${Object.keys(existingMedia).length} existing media files`);
                            
                            // Find the next available media ID
                            const existingIds = Object.keys(existingMedia).map(id => parseInt(id));
                            let nextMediaId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
                            
                                // Add new audio files to media mapping
                            completeMediaMapping = { ...existingMedia };
                            for (const audioFile of audioFilesToAdd) {
                                completeMediaMapping[nextMediaId] = audioFile.newFilename;
                                nextMediaId++;
                            }
                            
                            const mediaBuffer = Buffer.from(JSON.stringify(completeMediaMapping));
                            outputZip.addBuffer(mediaBuffer, 'media');
                            mediaProcessed = true;
                            
                            console.log(`📁 Media mapping updated: ${Object.keys(existingMedia).length} existing + ${audioFilesToAdd.size} new = ${Object.keys(completeMediaMapping).length} total`);
                            sourceZipfile.readEntry();
                        });
                    });
                } else if (/^\d+$/.test(entry.fileName)) {
                    // Existing media file, copy it over
                    sourceZipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        
                        // Add existing media file to output
                        outputZip.addReadStream(readStream, entry.fileName);
                        sourceZipfile.readEntry();
                    });
                } else {
                    // Other files (like meta), copy as-is
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
                console.log('📦 Adding generated audio files...');
                
                // Add the audio files using the media ID mapping we created
                let addedAudioCount = 0;
                for (const [mediaId, newFilename] of Object.entries(completeMediaMapping)) {
                    // Find the audio file info by new filename
                    const audioFileInfo = Array.from(audioFilesToAdd).find(af => af.newFilename === newFilename);
                    if (audioFileInfo) {
                        const audioPath = path.join(audioDir, audioFileInfo.oldFilename);
                        if (fs.existsSync(audioPath)) {
                            // Add audio file with numeric name (media ID)
                            outputZip.addFile(audioPath, mediaId);
                            addedAudioCount++;
                            console.log(`  Added: ${audioFileInfo.oldFilename} → ${mediaId} (${audioFileInfo.koreanText})`);
                        }
                    }
                }
                
                console.log(`🎵 Added ${addedAudioCount} audio files to deck`);
                
                // Finalize the zip
                outputZip.end();
                
                outputStream.on('close', () => {
                    const stats = fs.statSync(outputFile);
                    console.log('');
                    console.log('=== ✅ AUGMENTED DECK CREATED SUCCESSFULLY ===');
                    console.log(`📂 Output file: ${outputFile}`);
                    console.log(`📏 File size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
                    console.log(`🎵 Notes with audio: ${audioMapping.size}`);
                    console.log(`📁 Total media files: ${Object.keys(completeMediaMapping).length}`);
                    console.log('');
                    console.log('🎉 Your augmented Korean deck is ready!');
                    console.log('   Import it into Anki to use cards with audio.');
                    console.log('   The original deck is preserved safely.');
                    
                    resolve();
                });
            });
        });
    });
}

// Run the process
createAugmentedDeck().catch(error => {
    console.error('❌ Error creating augmented deck:', error);
    process.exit(1);
});