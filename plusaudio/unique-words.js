const yauzl = require('yauzl');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);

const inputFile = args[0];

const gen = async () => new Promise((res, rej) => {
    yauzl.open(inputFile, { lazyEntries: true }, async(err, zipFile) => {
            zipFile.readEntry();
            zipFile.on('entry', entry => {
                    if(entry.fileName === 'collection.anki21'){
                            zipFile.openReadStream(entry, async (err, readStream) => {
                                    const chunks = [];
                                    readStream.on('data', chunk => chunks.push(chunk));
                                    readStream.on('end', async () => {
                                            const buffer = Buffer.concat(chunks);
                                            const db = new Database(buffer);

                                            // Looking at all tables. Somewhere in anki, the actual field names are explained. But where?
                                            // It's definitely in the col table
                                            // Looks like there's only one row in col
                                            // It has a type called models
                                            // this has a single field for the id of the deck
                                            // col in general has a fucking lot, i'm surprised we were even able to recreate the deck at a ll
                                            // the deck has a name and tmpls, and flds
                                            // finally flds is pretty useful


                                            // Detect fields
                                            const col = db.prepare(`SELECT * FROM col LIMIT 1`).get();
                                            const models = JSON.parse(col.models);
                                            const deck = models[Object.keys(models)[0]];
                                            const flds = deck.flds;

                                            // Expand this to more languages later
                                            let koreanIdx = -1;
                                            let englishIdx = -1;

                                            for (fld of flds) {
                                                // A bit of an assumption here. Ideally we pass all {name,ord} to GPT
                                                // But this saves a call
                                                    if (fld.name === 'Korean')
                                                            koreanIdx = fld.ord;
                                                    if (fld.name === 'English') 
                                                            englishIdx = fld.ord;
                                            }


                                            const allNotes = db.prepare("SELECT id, flds FROM notes ORDER BY id").all();
                                            let i = 0;
                                            for (const note of allNotes) {
                                                    i++;
                                                    const fields = note.flds.split('\x1f');
                                                    const korean = fields[koreanIdx];
                                                    const english = fields[englishIdx];
                                                    
                                                    if (i > 1000 && i < 1010){
                                                            console.log(korean, '<=>', english);
                                                    }

                                                    if (i === 1011){
                                                            break;
                                                    }
                                            }

                                            db.close();
                                            res();
                                    });
                            });
                    } else {
                            zipFile.readEntry();
                    }
            });
            zipFile.on('end', () => {});
    });
});

if (require.main === module) {
    gen();
}
