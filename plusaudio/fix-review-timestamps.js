// Fix review timestamps to be in the past for proper Anki statistics
const fs = require('fs');
const yauzl = require('yauzl');
const yazl = require('yazl');
const Database = require('better-sqlite3');

const inputFile = 'Korean Vocabulary by Evita (with Audio).apkg';
const outputFile = 'Korean Vocabulary by Evita (with Audio) - Fixed Timestamps.apkg';

console.log('=== FIXING REVIEW TIMESTAMPS FOR ANKI STATISTICS ===');
console.log(`Input: ${inputFile}`);
console.log(`Output: ${outputFile}`);
console.log('');

async function fixReviewTimestamps() {
    return new Promise((resolve, reject) => {
        yauzl.open(inputFile, { lazyEntries: true }, (err, sourceZipfile) => {
            if (err) {
                reject(err);
                return;
            }

            const outputZip = new yazl.ZipFile();
            const outputStream = fs.createWriteStream(outputFile);
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

                            console.log('📊 Analyzing current review timestamps...');
                            
                            // Get timestamp range
                            const timestampRange = db.prepare("SELECT MIN(id) as earliest, MAX(id) as latest, COUNT(*) as count FROM revlog").get();
                            console.log(`   Current range: ${new Date(timestampRange.earliest).toISOString()} - ${new Date(timestampRange.latest).toISOString()}`);
                            console.log(`   Total reviews: ${timestampRange.count}`);
                            
                            // Calculate how far back to shift timestamps
                            const now = Date.now();
                            const latestReview = timestampRange.latest;
                            const earliestReview = timestampRange.earliest;
                            const reviewSpan = latestReview - earliestReview; // How long the review period was
                            
                            // Shift all reviews to end 3 days ago (recent but clearly in the past)
                            const targetLatest = now -1;//- (1 * 1 * 60 * 60 * 1000); // 3 days ago
                            const targetEarliest = targetLatest - reviewSpan; // Maintain the same span
                            const timeOffset = targetLatest - latestReview;
                            
                            console.log(`📅 Shifting timestamps:`);
                            console.log(`   Target range: ${new Date(targetEarliest).toISOString()} - ${new Date(targetLatest).toISOString()}`);
                            console.log(`   Time offset: ${Math.round(timeOffset / (1000 * 60 * 60 * 24))} days`);
                            
                            // Update all revlog timestamps
                            console.log('🔄 Updating review timestamps...');
                            const updateStmt = db.prepare("UPDATE revlog SET id = id + ?");
                            const result = updateStmt.run(timeOffset);
                            console.log(`   Updated ${result.changes} review entries`);
                            
                            // Verify the update
                            const newRange = db.prepare("SELECT MIN(id) as earliest, MAX(id) as latest FROM revlog").get();
                            console.log(`   New range: ${new Date(newRange.earliest).toISOString()} - ${new Date(newRange.latest).toISOString()}`);
                            
                            // Update collection modification time to current
                            const currentTime = Math.floor(Date.now() / 1000);
                            const updateColStmt = db.prepare("UPDATE col SET mod = ?");
                            updateColStmt.run(currentTime);
                            console.log(`   Updated collection modification time to: ${new Date(currentTime * 1000).toISOString()}`);

                            // Serialize and add to output
                            const serialized = db.serialize();
                            db.close();
                            
                            outputZip.addBuffer(Buffer.from(serialized), entry.fileName);
                            sourceZipfile.readEntry();
                        });
                    });
                } else {
                    // Copy all other files as-is
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
                    const stats = fs.statSync(outputFile);
                    console.log('');
                    console.log('=== ✅ TIMESTAMPS FIXED SUCCESSFULLY ===');
                    console.log(`📂 Output file: ${outputFile}`);
                    console.log(`📏 File size: ${(stats.size / 1024 / 1024).toFixed(1)} MB`);
                    console.log('');
                    console.log('🎉 Your deck now has properly dated review history!');
                    console.log('   Import this version and check Statistics → Reviews/Calendar');
                    console.log('   All reviews are now in the past and should display correctly');
                    
                    resolve();
                });
            });
        });
    });
}

fixReviewTimestamps().catch(console.error);