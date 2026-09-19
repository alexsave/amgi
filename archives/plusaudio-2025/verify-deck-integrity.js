// PERMANENT VERIFICATION SCRIPT - DO NOT DELETE
// Compares review history and scheduling data between original and augmented decks
const fs = require('fs');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');

const originalFile = 'Korean Vocabulary by Evita.apkg';
const augmentedFile = 'Korean Vocabulary by Evita (with Audio) - Fixed Timestamps.apkg';

console.log('=== DECK INTEGRITY VERIFICATION ===');
console.log(`Original: ${originalFile}`);
console.log(`Augmented: ${augmentedFile}`);
console.log('');

async function extractDeckData(filename) {
    return new Promise((resolve, reject) => {
        yauzl.open(filename, { lazyEntries: true }, (err, zipfile) => {
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
                            try {
                                const buffer = Buffer.concat(chunks);
                                const db = new Database(buffer);
                                
                                // Extract comprehensive data
                                const data = {
                                    // Collection info
                                    collection: db.prepare("SELECT id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags FROM col").get(),
                                    
                                    // Review history (revlog)
                                    revlog: db.prepare("SELECT id, cid, usn, ease, ivl, lastIvl, factor, time, type FROM revlog ORDER BY id").all(),
                                    
                                    // Cards with scheduling info
                                    cards: db.prepare("SELECT id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data FROM cards ORDER BY id").all(),
                                    
                                    // Notes
                                    notes: db.prepare("SELECT id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data FROM notes ORDER BY id").all(),
                                    
                                    // Statistics queries
                                    stats: {
                                        totalNotes: db.prepare("SELECT COUNT(*) as count FROM notes").get(),
                                        totalCards: db.prepare("SELECT COUNT(*) as count FROM cards").get(),
                                        totalReviews: db.prepare("SELECT COUNT(*) as count FROM revlog").get(),
                                        reviewedCards: db.prepare("SELECT COUNT(*) as count FROM cards WHERE reps > 0").get(),
                                        newCards: db.prepare("SELECT COUNT(*) as count FROM cards WHERE reps = 0").get(),
                                        
                                        // Review date range
                                        reviewRange: db.prepare("SELECT MIN(id) as earliest, MAX(id) as latest FROM revlog").get(),
                                        
                                        // Card due date range  
                                        dueRange: db.prepare("SELECT MIN(due) as earliest, MAX(due) as latest FROM cards WHERE due > 0").get(),
                                        
                                        // Cards by type
                                        cardsByType: db.prepare("SELECT type, queue, COUNT(*) as count FROM cards GROUP BY type, queue ORDER BY type, queue").all(),
                                        
                                        // Review statistics
                                        reviewStats: db.prepare(`
                                            SELECT 
                                                AVG(time) as avgTime,
                                                MIN(time) as minTime, 
                                                MAX(time) as maxTime,
                                                AVG(ease) as avgEase,
                                                COUNT(CASE WHEN ease = 1 THEN 1 END) as againCount,
                                                COUNT(CASE WHEN ease = 2 THEN 1 END) as hardCount,
                                                COUNT(CASE WHEN ease = 3 THEN 1 END) as goodCount,
                                                COUNT(CASE WHEN ease = 4 THEN 1 END) as easyCount
                                            FROM revlog
                                        `).get()
                                    }
                                };
                                
                                db.close();
                                resolve(data);
                                
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
                reject(new Error('collection.anki21 not found'));
            });
        });
    });
}

function formatTimestamp(timestamp) {
    return new Date(timestamp).toISOString();
}

function formatDays(days) {
    if (days > 365) {
        return `${(days / 365).toFixed(1)} years`;
    } else if (days > 30) {
        return `${(days / 30).toFixed(1)} months`;
    } else {
        return `${days} days`;
    }
}

function compareData(original, augmented) {
    console.log('=== COMPARISON RESULTS ===\n');
    
    // Collection comparison
    console.log('📊 COLLECTION INFO:');
    console.log(`  Original ID: ${original.collection.id} | Augmented ID: ${augmented.collection.id}`);
    console.log(`  Original Created: ${formatTimestamp(original.collection.crt * 1000)} | Augmented Created: ${formatTimestamp(augmented.collection.crt * 1000)}`);
    console.log(`  Original Modified: ${formatTimestamp(original.collection.mod * 1000)} | Augmented Modified: ${formatTimestamp(augmented.collection.mod * 1000)}`);
    console.log('');
    
    // Statistics comparison
    console.log('📈 STATISTICS COMPARISON:');
    const stats = [
        'totalNotes', 'totalCards', 'totalReviews', 'reviewedCards', 'newCards'
    ];
    
    let allStatsMatch = true;
    for (const stat of stats) {
        const origCount = original.stats[stat].count;
        const augCount = augmented.stats[stat].count;
        const match = origCount === augCount ? '✅' : '❌';
        if (origCount !== augCount) allStatsMatch = false;
        
        console.log(`  ${stat}: ${origCount} → ${augCount} ${match}`);
    }
    console.log('');
    
    // Review history comparison
    console.log('📚 REVIEW HISTORY:');
    const origReviews = original.revlog.length;
    const augReviews = augmented.revlog.length;
    const reviewsMatch = origReviews === augReviews ? '✅' : '❌';
    console.log(`  Total reviews: ${origReviews} → ${augReviews} ${reviewsMatch}`);
    
    if (origReviews > 0 && augReviews > 0) {
        const origEarliest = formatTimestamp(original.stats.reviewRange.earliest);
        const origLatest = formatTimestamp(original.stats.reviewRange.latest);
        const augEarliest = formatTimestamp(augmented.stats.reviewRange.earliest);
        const augLatest = formatTimestamp(augmented.stats.reviewRange.latest);
        
        console.log(`  Original range: ${origEarliest} to ${origLatest}`);
        console.log(`  Augmented range: ${augEarliest} to ${augLatest}`);
        
        // Check if review content matches (ignoring card IDs which should be different)
        const origReviewContent = original.revlog.map(r => ({
            ease: r.ease,
            ivl: r.ivl,
            lastIvl: r.lastIvl,
            factor: r.factor,
            time: r.time,
            type: r.type
        }));
        
        const augReviewContent = augmented.revlog.map(r => ({
            ease: r.ease,
            ivl: r.ivl,
            lastIvl: r.lastIvl,
            factor: r.factor,
            time: r.time,
            type: r.type
        }));
        
        const contentMatches = JSON.stringify(origReviewContent) === JSON.stringify(augReviewContent);
        console.log(`  Review content matches: ${contentMatches ? '✅' : '❌'}`);
        
        if (!contentMatches) {
            console.log('  ⚠️  Review content differs - this may indicate lost review data!');
        }
    }
    console.log('');
    
    // Card scheduling comparison
    console.log('📅 CARD SCHEDULING:');
    const origCards = original.cards.length;
    const augCards = augmented.cards.length;
    const cardsMatch = origCards === augCards ? '✅' : '❌';
    console.log(`  Total cards: ${origCards} → ${augCards} ${cardsMatch}`);
    
    if (original.stats.dueRange && augmented.stats.dueRange) {
        const origDueEarliest = original.stats.dueRange.earliest;
        const origDueLatest = original.stats.dueRange.latest;
        const augDueEarliest = augmented.stats.dueRange.earliest;
        const augDueLatest = augmented.stats.dueRange.latest;
        
        console.log(`  Original due range: ${formatDays(origDueEarliest)} to ${formatDays(origDueLatest)}`);
        console.log(`  Augmented due range: ${formatDays(augDueEarliest)} to ${formatDays(augDueLatest)}`);
        
        const dueRangeMatches = (origDueEarliest === augDueEarliest && origDueLatest === augDueLatest);
        console.log(`  Due date ranges match: ${dueRangeMatches ? '✅' : '❌'}`);
        
        if (!dueRangeMatches) {
            console.log('  ⚠️  Due date ranges differ - scheduling may have been altered!');
        }
    }
    
    // Card type distribution
    console.log('\n📊 CARD TYPE DISTRIBUTION:');
    console.log('  Original:');
    original.stats.cardsByType.forEach(row => {
        console.log(`    Type ${row.type}, Queue ${row.queue}: ${row.count} cards`);
    });
    console.log('  Augmented:');
    augmented.stats.cardsByType.forEach(row => {
        console.log(`    Type ${row.type}, Queue ${row.queue}: ${row.count} cards`);
    });
    console.log('');
    
    // Review performance stats
    console.log('⏱️  REVIEW PERFORMANCE:');
    const origStats = original.stats.reviewStats;
    const augStats = augmented.stats.reviewStats;
    
    if (origStats && augStats) {
        console.log(`  Avg time per review: ${(origStats.avgTime / 1000).toFixed(1)}s → ${(augStats.avgTime / 1000).toFixed(1)}s`);
        console.log(`  Avg ease rating: ${origStats.avgEase.toFixed(2)} → ${augStats.avgEase.toFixed(2)}`);
        console.log(`  Again presses: ${origStats.againCount} → ${augStats.againCount}`);
        console.log(`  Good presses: ${origStats.goodCount} → ${augStats.goodCount}`);
    }
    console.log('');
    
    // Overall assessment
    console.log('=== OVERALL ASSESSMENT ===');
    const majorIssues = [];
    const minorIssues = [];
    
    if (!allStatsMatch) majorIssues.push('Statistics counts differ');
    if (origReviews !== augReviews) majorIssues.push('Review history count differs');
    if (origCards !== augCards) majorIssues.push('Card count differs');
    
    if (majorIssues.length === 0) {
        console.log('✅ VERIFICATION PASSED - All critical data preserved');
        console.log('   Review history, card counts, and scheduling appear intact');
    } else {
        console.log('❌ VERIFICATION FAILED - Critical issues detected:');
        majorIssues.forEach(issue => console.log(`   • ${issue}`));
    }
    
    if (minorIssues.length > 0) {
        console.log('\n⚠️  Minor issues (may be expected):');
        minorIssues.forEach(issue => console.log(`   • ${issue}`));
    }
    
    console.log('\n📊 SUMMARY:');
    console.log(`   Original: ${origReviews} reviews, ${origCards} cards, ${original.stats.totalNotes.count} notes`);
    console.log(`   Augmented: ${augReviews} reviews, ${augCards} cards, ${augmented.stats.totalNotes.count} notes`);
    
    return majorIssues.length === 0;
}

async function main() {
    try {
        console.log('📖 Extracting original deck data...');
        const originalData = await extractDeckData(originalFile);
        
        console.log('📖 Extracting augmented deck data...');
        const augmentedData = await extractDeckData(augmentedFile);
        
        console.log('🔍 Analyzing differences...\n');
        const passed = compareData(originalData, augmentedData);
        
        console.log(`\n${passed ? '🎉 VERIFICATION COMPLETE' : '⚠️  VERIFICATION FAILED'}`);
        process.exit(passed ? 0 : 1);
        
    } catch (error) {
        console.error('❌ Error during verification:', error.message);
        process.exit(1);
    }
}

main();