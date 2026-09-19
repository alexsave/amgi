// Create augmented .apkg file with embedded audio
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const yazl = require('yazl');
const Database = require('better-sqlite3');

const sourceFile = 'Korean Vocabulary by Evita (with Audio).apkg';
const outputFile = 'Korean Vocabulary by Evita (with Audio updated).apkg';
const audioDir = 'audio';

console.log('=== UPDATING KOREAN DECK WITH CURRENT AUDIO FILES ===');
console.log(`Source: ${sourceFile}`);
console.log(`Output: ${outputFile}`);
console.log('');

// Scan audio directory for available files
console.log('🎵 Scanning audio directory for available files...');
let audioFiles = [];
try {
    const files = fs.readdirSync(audioDir);
    audioFiles = files.filter(file => file.endsWith('_gpt4o.mp3'));
    console.log(`   Found ${audioFiles.length} audio files in ${audioDir}/`);
} catch (error) {
    console.error('❌ Error reading audio directory:', error.message);
    process.exit(1);
}

// Create mapping of Korean text to audio file info
const audioMapping = new Map();
audioFiles.forEach(filename => {
    // Extract Korean text from filename (remove _gpt4o.mp3 suffix)
    const koreanText = filename.replace('_gpt4o.mp3', '');
    audioMapping.set(koreanText, {
        filename: filename,
        filepath: path.join(audioDir, filename),
        koreanText: koreanText
    });
});

console.log(`🎵 Audio files available for ${audioMapping.size} Korean terms`);
console.log('   Sample files:', Array.from(audioMapping.keys()).slice(0, 5).join(', '));
console.log('');

async function updateAugmentedDeck() {
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
                                
                                // Check what tables exist to ensure we update all relevant ones
                                console.log('🔍 Checking database structure...');
                                const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
                                const tableNames = tables.map(t => t.name);
                                console.log(`   Found tables: ${tableNames.join(', ')}`);
                                
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
                                const selectCardsStmt = db.prepare("SELECT id, nid FROM cards");
                                const cardIdMapping = new Map(); // old card ID -> new card ID
                                
                                const notes = selectStmt.all();
                                console.log(`📝 Processing ${notes.length} notes with new IDs to avoid collection conflicts...`);
                                
                                for (const note of notes) {
                                    // Generate new ID and GUID for this note to avoid collection conflicts
                                    const oldId = note.id;
                                    const newId = generateNewId();
                                    const newGuid = generateNewGuid();
                                    noteIdMapping.set(oldId, newId);
                                    
                                    const fields = note.flds.split('\x1f');
                                    let updatedFields = note.flds; // default to original
                                    
                                    // Find Korean text in the fields (typically field 0 or 1)
                                    let koreanText = null;
                                    let audioInfo = null;
                                    
                                    // Try to find matching Korean text in the first few fields
                                    for (let i = 0; i < Math.min(3, fields.length); i++) {
                                        const fieldText = fields[i]?.trim();
                                        if (fieldText && audioMapping.has(fieldText)) {
                                            koreanText = fieldText;
                                            audioInfo = audioMapping.get(fieldText);
                                            break;
                                        }
                                    }
                                    
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
                                        } else {
                                            console.log(`  Added new audio for "${audioInfo.koreanText}" as ${safeFilename}`);
                                        }
                                    }
                                    
                                    // Update the note with new ID, GUID (and updated fields if applicable)
                                    updateStmt.run(updatedFields, newId, newGuid, oldId);
                                    
                                    // Update all cards that reference this note
                                    updateCardsStmt.run(newId, oldId);
                                }
                                
                                // Now update all card IDs and track the mappings for revlog updates
                                console.log('📝 Generating new card IDs and updating review log...');
                                const allCards = selectCardsStmt.all();
                                console.log(`📝 Processing ${allCards.length} cards with new IDs...`);
                                
                                for (const card of allCards) {
                                    const oldCardId = card.id;
                                    const newCardId = generateNewId();
                                    cardIdMapping.set(oldCardId, newCardId);
                                    
                                    // Update the card with new ID
                                    const updateCardIdStmt = db.prepare("UPDATE cards SET id = ? WHERE id = ?");
                                    updateCardIdStmt.run(newCardId, oldCardId);
                                }
                                
                                // Update revlog to reference new card IDs (preserve original timestamps)
                                console.log('📊 Updating review log with new card IDs (preserving original timestamps)...');
                                
                                let revlogUpdated = 0;
                                for (const [oldCardId, newCardId] of cardIdMapping) {
                                    // Only update card ID, preserve original timestamps
                                    const updateRevlogStmt = db.prepare("UPDATE revlog SET cid = ? WHERE cid = ?");
                                    const result = updateRevlogStmt.run(newCardId, oldCardId);
                                    revlogUpdated += result.changes;
                                }
                                console.log(`📊 Updated ${revlogUpdated} review log entries with new card IDs (timestamps preserved)`);
                                
                                console.log(`✅ Generated new IDs for all ${notes.length} notes and ${allCards.length} cards to avoid collection conflicts`);
                                console.log(`🎵 Updated ${updatedCount} notes with audio references`);
                                console.log(`📊 Preserved ${revlogUpdated} review history entries`);
                                console.log(`📁 New media files to add: ${audioFilesToAdd.size}`);
                                
                                // Update collection ID to ensure separate import (preserve original creation time)
                                console.log('📝 Creating new collection ID while preserving original metadata...');
                                const originalCol = db.prepare("SELECT crt FROM col").get();
                                const newCollectionId = Date.now();
                                const currentTime = Math.floor(Date.now() / 1000); // Unix timestamp in seconds
                                
                                console.log(`   Changing collection ID: 1 → ${newCollectionId}`);
                                console.log(`   Preserving original creation time: ${new Date(originalCol.crt * 1000).toISOString()}`);
                                console.log(`   Setting modification time: ${new Date(currentTime * 1000).toISOString()}`);
                                
                                // Update collection with new ID but preserve original creation time
                                const updateColStmt = db.prepare("UPDATE col SET id = ?, mod = ?");
                                updateColStmt.run(newCollectionId, currentTime);
                                
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
                                                name: 'Korean Vocabulary by Evita (with Audio 2)',
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
                    console.log('=== ✅ UPDATED DECK CREATED SUCCESSFULLY ===');
                    console.log(`📂 Output file: ${outputFile}`);
                    console.log(`📏 File size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
                    console.log(`🎵 Available audio files: ${audioMapping.size}`);
                    console.log(`🎵 Notes updated with audio: ${updatedCount}`);
                    console.log(`📁 Total media files: ${Object.keys(completeMediaMapping).length}`);
                    console.log('');
                    console.log('🎉 Your updated Korean deck is ready!');
                    console.log('   Import it into Anki to use cards with current audio files.');
                    console.log('   All your review history and statistics are preserved.');
                    console.log('   The original deck is preserved safely.');
                    
                    resolve();
                });
            });
        });
    });
}

// Run the process
updateAugmentedDeck().catch(error => {
    console.error('❌ Error updating augmented deck:', error);
    process.exit(1);
});