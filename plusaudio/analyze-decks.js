// Analyze differences between two Anki decks (.apkg/.colpkg)
// Usage: node analyze-decks.js "/path/deck2.apkg" "/path/deck3.apkg"

const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const Database = require('better-sqlite3');

function openZip(apkgPath) {
    return new Promise((resolve, reject) => {
        const result = {
            hasCollection: false,
            collectionName: null,
            collectionBuffer: null,
            mediaJson: {},
            mediaNumericFiles: new Set(),
            isSqliteHeader: null,
        };

        yauzl.open(apkgPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
                reject(err);
                return;
            }

            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                if (entry.fileName === 'collection.anki21' || entry.fileName === 'collection.anki2') {
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        const chunks = [];
                        readStream.on('data', (c) => chunks.push(c));
                        readStream.on('end', () => {
                            result.collectionBuffer = Buffer.concat(chunks);
                            result.collectionName = entry.fileName;
                            result.hasCollection = true;
                            // Check SQLite header
                            try {
                                const header = result.collectionBuffer.slice(0, 16).toString();
                                result.isSqliteHeader = header === 'SQLite format 3\u0000';
                            } catch {
                                result.isSqliteHeader = false;
                            }
                            zipfile.readEntry();
                        });
                    });
                } else if (entry.fileName === 'media') {
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        const chunks = [];
                        readStream.on('data', (c) => chunks.push(c));
                        readStream.on('end', () => {
                            try {
                                const content = Buffer.concat(chunks).toString();
                                result.mediaJson = content.trim() ? JSON.parse(content) : {};
                            } catch {
                                result.mediaJson = {};
                            }
                            zipfile.readEntry();
                        });
                    });
                } else if (/^\d+$/.test(entry.fileName)) {
                    result.mediaNumericFiles.add(entry.fileName);
                    zipfile.readEntry();
                } else {
                    zipfile.readEntry();
                }
            });

            zipfile.on('end', () => resolve(result));
            zipfile.on('error', (e) => reject(e));
        });
    });
}

function analyzeDatabase(dbBuffer) {
    const analysis = {
        col: null,
        counts: { notes: 0, cards: 0, revlog: 0 },
        schemas: {},
        audioReferences: new Set(),
        revlogIdRange: null,
        decksKeys: [],
        modelsKeys: [],
    };

    const db = new Database(dbBuffer);

    try {
        const colRow = db.prepare('SELECT * FROM col LIMIT 1').get();
        analysis.col = colRow || null;

        const tables = ['notes', 'cards', 'revlog'];
        for (const tableName of tables) {
            try {
                const cnt = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get();
                analysis.counts[tableName] = cnt?.c || 0;
            } catch {
                analysis.counts[tableName] = null;
            }

            try {
                const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
                analysis.schemas[tableName] = cols.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, pk: c.pk }));
            } catch {
                analysis.schemas[tableName] = null;
            }
        }

        try {
            const r = db.prepare('SELECT MIN(id) AS minId, MAX(id) AS maxId FROM revlog').get();
            if (r && r.minId != null && r.maxId != null) {
                analysis.revlogIdRange = { min: r.minId, max: r.maxId, spanMs: r.maxId - r.minId };
            }
        } catch {}

        try {
            const rows = db.prepare('SELECT flds FROM notes').all();
            const soundRegex = /\[sound:([^\]]+)]/g;
            for (const row of rows) {
                if (typeof row.flds !== 'string') continue;
                let m;
                while ((m = soundRegex.exec(row.flds)) !== null) {
                    analysis.audioReferences.add(m[1]);
                }
            }
        } catch {}

        try {
            const decksJson = analysis.col?.decks ? JSON.parse(analysis.col.decks) : {};
            const modelsJson = analysis.col?.models ? JSON.parse(analysis.col.models) : {};
            analysis.decksKeys = Object.keys(decksJson || {});
            analysis.modelsKeys = Object.keys(modelsJson || {});
        } catch {}
    } finally {
        db.close();
    }

    return analysis;
}

function validateMediaConsistency(analysis, mediaJson, mediaNumericFiles) {
    const issues = {
        mappingCount: Object.keys(mediaJson || {}).length,
        fileCount: mediaNumericFiles.size,
        missingInMapping: [],
        missingNumericFiles: [],
        duplicateFilenames: [],
    };

    const filenameToIds = new Map();
    for (const [id, name] of Object.entries(mediaJson || {})) {
        const arr = filenameToIds.get(name) || [];
        arr.push(id);
        filenameToIds.set(name, arr);
    }

    for (const [name, ids] of filenameToIds.entries()) {
        if (ids.length > 1) {
            issues.duplicateFilenames.push({ filename: name, mediaIds: ids });
        }
    }

    for (const filename of analysis.audioReferences) {
        const mediaId = [...Object.entries(mediaJson || {})].find(([, name]) => name === filename)?.[0];
        if (!mediaId) {
            issues.missingInMapping.push(filename);
            continue;
        }
        if (!mediaNumericFiles.has(String(mediaId))) {
            issues.missingNumericFiles.push({ filename, mediaId: String(mediaId) });
        }
    }

    return issues;
}

function printSummary(label, zipInfo, dbInfo, mediaIssues) {
    console.log(`\n=== ${label} ===`);
    console.log(`Collection file: ${zipInfo.collectionName || 'MISSING'}`);
    console.log(`Has collection: ${zipInfo.hasCollection}`);
    if (zipInfo.hasCollection) {
        console.log(`Collection is valid SQLite header: ${zipInfo.isSqliteHeader}`);
    }
    console.log(`Media entries: mapping=${mediaIssues.mappingCount}, files=${mediaIssues.fileCount}`);

    if (dbInfo.col) {
        const ver = dbInfo.col.ver;
        const mod = dbInfo.col.mod;
        const id = dbInfo.col.id;
        console.log(`col: { id: ${id}, ver: ${ver}, mod: ${mod} }`);
    } else {
        console.log('col: MISSING');
    }

    console.log(`counts: notes=${dbInfo.counts.notes}, cards=${dbInfo.counts.cards}, revlog=${dbInfo.counts.revlog}`);
    console.log(`tables:`);
    for (const [t, cols] of Object.entries(dbInfo.schemas)) {
        if (cols) {
            console.log(`  ${t}: ${cols.map((c) => c.name + (c.pk ? ' (pk)' : '')).join(', ')}`);
        } else {
            console.log(`  ${t}: MISSING`);
        }
    }

    if (dbInfo.revlogIdRange) {
        console.log(`revlog id range: ${dbInfo.revlogIdRange.min} → ${dbInfo.revlogIdRange.max} (span ${Math.round(dbInfo.revlogIdRange.spanMs / (1000 * 60 * 60 * 24))} days)`);
    }

    console.log(`decks: ${dbInfo.decksKeys.length} keys, models: ${dbInfo.modelsKeys.length} keys`);

    if (mediaIssues.missingInMapping.length > 0) {
        console.log(`MISSING in media mapping (${mediaIssues.missingInMapping.length}):`);
        console.log(`  ${mediaIssues.missingInMapping.slice(0, 20).join(', ')}` + (mediaIssues.missingInMapping.length > 20 ? ' ...' : ''));
    }
    if (mediaIssues.missingNumericFiles.length > 0) {
        console.log(`MISSING numeric media files (${mediaIssues.missingNumericFiles.length}):`);
        for (const m of mediaIssues.missingNumericFiles.slice(0, 20)) {
            console.log(`  id ${m.mediaId} for ${m.filename}`);
        }
        if (mediaIssues.missingNumericFiles.length > 20) console.log('  ...');
    }
    if (mediaIssues.duplicateFilenames.length > 0) {
        console.log(`Duplicate filenames in media mapping (${mediaIssues.duplicateFilenames.length}):`);
        for (const d of mediaIssues.duplicateFilenames.slice(0, 10)) {
            console.log(`  ${d.filename} -> ids [${d.mediaIds.join(', ')}]`);
        }
        if (mediaIssues.duplicateFilenames.length > 10) console.log('  ...');
    }
}

function diffSummaries(a, b) {
    console.log('\n=== DIFF (Deck B - Deck A) ===');
    const getCol = (x) => x.db.col || {};
    const aCol = getCol(a);
    const bCol = getCol(b);
    console.log(`col.ver: ${aCol.ver} -> ${bCol.ver}`);
    console.log(`counts.notes: ${a.db.counts.notes} -> ${b.db.counts.notes}`);
    console.log(`counts.cards: ${a.db.counts.cards} -> ${b.db.counts.cards}`);
    console.log(`counts.revlog: ${a.db.counts.revlog} -> ${b.db.counts.revlog}`);
    console.log(`media.mappingCount: ${a.media.mappingCount} -> ${b.media.mappingCount}`);
    console.log(`media.fileCount: ${a.media.fileCount} -> ${b.media.fileCount}`);
    console.log(`media.missingInMapping: ${a.media.missingInMapping.length} -> ${b.media.missingInMapping.length}`);
    console.log(`media.missingNumericFiles: ${a.media.missingNumericFiles.length} -> ${b.media.missingNumericFiles.length}`);
}

async function analyze(apkgPath) {
    const zipInfo = await openZip(apkgPath);
    if (!zipInfo.hasCollection || !zipInfo.collectionBuffer) {
        return { zip: zipInfo, db: { col: null, counts: {}, schemas: {} }, media: { mappingCount: 0, fileCount: 0, missingInMapping: [], missingNumericFiles: [], duplicateFilenames: [] } };
    }
    const dbInfo = analyzeDatabase(zipInfo.collectionBuffer);
    const mediaIssues = validateMediaConsistency(dbInfo, zipInfo.mediaJson, zipInfo.mediaNumericFiles);
    return { zip: zipInfo, db: dbInfo, media: mediaIssues };
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.log('Usage: node analyze-decks.js "/path/to/deck2.apkg" "/path/to/deck3.apkg"');
        process.exit(1);
    }

    const deckA = args[0];
    const deckB = args[1];

    if (!fs.existsSync(deckA)) {
        console.error(`Not found: ${deckA}`);
        process.exit(1);
    }
    if (!fs.existsSync(deckB)) {
        console.error(`Not found: ${deckB}`);
        process.exit(1);
    }

    console.log(`Analyzing:\n A: ${deckA}\n B: ${deckB}`);
    const a = await analyze(deckA);
    const b = await analyze(deckB);

    printSummary('Deck A', a.zip, a.db, a.media);
    printSummary('Deck B', b.zip, b.db, b.media);
    diffSummaries(a, b);

    console.log('\nHints:');
    console.log('- If col.ver is unexpectedly high or invalid, Anki may reject import.');
    console.log('- Missing media mapping or missing numeric media files can break imports.');
    console.log('- Ensure collection.anki21 exists and media mapping keys are numeric strings.');
}

if (require.main === module) {
    main();
}


