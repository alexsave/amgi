// Debug revlog and card ID mismatch in augmented deck
const fs = require('fs');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');

const augmentedFile = 'Korean Vocabulary by Evita (with Audio).apkg';

console.log('=== DEBUGGING REVLOG AND CARD ID MISMATCH ===');
console.log(`Checking: ${augmentedFile}`);
console.log('');

async function debugRevlogMismatch() {
    return new Promise((resolve, reject) => {
        yauzl.open(augmentedFile, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                reject(err);
                return;
            }

            zipfile.readEntry();
            zipfile.on("entry", (entry) => {
                if (entry.fileName === 'collection.anki21') {
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }

                        const chunks = [];
                        readStream.on('data', chunk => chunks.push(chunk));
                        readStream.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            const db = new Database(buffer);

                            console.log('🔍 CARD ID ANALYSIS:');
                            
                            // Get all card IDs
                            const cardIds = db.prepare("SELECT id FROM cards ORDER BY id LIMIT 10").all();
                            console.log('First 10 card IDs:', cardIds.map(c => c.id));
                            
                            // Get card ID range
                            const cardRange = db.prepare("SELECT MIN(id) as min, MAX(id) as max, COUNT(*) as count FROM cards").get();
                            console.log(`Card ID range: ${cardRange.min} - ${cardRange.max} (${cardRange.count} cards)`);
                            
                            console.log('\n🔍 REVLOG ANALYSIS:');
                            
                            // Get all revlog card IDs
                            const revlogCardIds = db.prepare("SELECT DISTINCT cid FROM revlog ORDER BY cid LIMIT 10").all();
                            console.log('First 10 revlog card IDs:', revlogCardIds.map(r => r.cid));
                            
                            // Get revlog card ID range
                            const revlogRange = db.prepare("SELECT MIN(cid) as min, MAX(cid) as max, COUNT(*) as count FROM revlog").get();
                            console.log(`Revlog card ID range: ${revlogRange.min} - ${revlogRange.max} (${revlogRange.count} entries)`);
                            
                            console.log('\n🔍 MISMATCH ANALYSIS:');
                            
                            // Check for mismatched card IDs
                            const mismatchedRevlog = db.prepare(`
                                SELECT cid, COUNT(*) as count 
                                FROM revlog 
                                WHERE cid NOT IN (SELECT id FROM cards) 
                                GROUP BY cid 
                                ORDER BY count DESC 
                                LIMIT 10
                            `).all();
                            
                            if (mismatchedRevlog.length > 0) {
                                console.log('❌ FOUND MISMATCHED REVLOG ENTRIES:');
                                console.log('These revlog entries reference card IDs that don\'t exist:');
                                mismatchedRevlog.forEach(entry => {
                                    console.log(`  Card ID ${entry.cid}: ${entry.count} review entries`);
                                });
                                
                                const totalMismatched = mismatchedRevlog.reduce((sum, entry) => sum + entry.count, 0);
                                console.log(`Total mismatched revlog entries: ${totalMismatched}/${revlogRange.count}`);
                            } else {
                                console.log('✅ All revlog entries have matching card IDs');
                            }
                            
                            // Check for cards without revlog entries
                            const cardsWithoutRevlog = db.prepare(`
                                SELECT id 
                                FROM cards 
                                WHERE id NOT IN (SELECT DISTINCT cid FROM revlog) 
                                LIMIT 10
                            `).all();
                            
                            if (cardsWithoutRevlog.length > 0) {
                                console.log('\n⚠️  CARDS WITHOUT REVLOG ENTRIES:');
                                console.log('These cards have no review history:');
                                cardsWithoutRevlog.forEach(card => {
                                    console.log(`  Card ID: ${card.id}`);
                                });
                            } else {
                                console.log('\n✅ All cards have revlog entries');
                            }
                            
                            console.log('\n🔍 SAMPLE CARD-REVLOG MATCHING:');
                            
                            // Sample a few cards and their revlog entries
                            const sampleMatching = db.prepare(`
                                SELECT c.id as card_id, COUNT(r.id) as review_count,
                                       MIN(r.id) as earliest_review, MAX(r.id) as latest_review
                                FROM cards c
                                LEFT JOIN revlog r ON c.id = r.cid
                                GROUP BY c.id
                                ORDER BY c.id
                                LIMIT 5
                            `).all();
                            
                            sampleMatching.forEach(sample => {
                                const earliestDate = sample.earliest_review ? new Date(sample.earliest_review).toISOString() : 'None';
                                const latestDate = sample.latest_review ? new Date(sample.latest_review).toISOString() : 'None';
                                console.log(`  Card ${sample.card_id}: ${sample.review_count} reviews (${earliestDate} - ${latestDate})`);
                            });

                            db.close();
                            resolve();
                        });
                    });
                } else {
                    zipfile.readEntry();
                }
            });

            zipfile.on("end", () => {
                reject(new Error('collection.anki21 not found'));
            });
        });
    });
}

debugRevlogMismatch().catch(console.error);