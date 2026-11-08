// The settings every drive starts from, written where the page keeps them: cdom's store (IndexedDB
// "cdom", object store "kv"), key amgi:anki-settings:1, as the block of X-Amgi-* header lines the
// page sends with every request (ui/src/settings.c), each value percent-encoded.
//
// It is written from /__seed__, a 404 on the app's origin, so no page of the app runs before the
// settings are there. The Anki folder is never left empty: empty means the user's real Anki folder.
export async function seed(b, at, { baseDir, collection = '', profile = '' }) {
  if (!baseDir) throw new Error('seed: no Anki folder (an empty one would be the real Anki folder)');
  await b.send('Page.navigate', { url: `${at}/__seed__` });
  for (let i = 0; i < 100 && (await b.evaluate('document.readyState')) !== 'complete'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const block = [
    ['X-Amgi-Base-Dir', baseDir], ['X-Amgi-Collection', collection], ['X-Amgi-Profile', profile],
    ['X-Amgi-Bridge-Url', 'http://127.0.0.1:8798'], ['X-Amgi-Bridge-Token', ''],
  ].map(([k, v]) => `${k}: ${encodeURIComponent(v)}\n`).join('');
  const bytes = [...new TextEncoder().encode(block)].join(',');
  await b.evaluate(`new Promise((resolve, reject) => {
    const open = indexedDB.open('cdom', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(new Uint8Array([${bytes}]), 'amgi:anki-settings:1');
      tx.oncomplete = () => { open.result.close(); resolve(true); };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  })`);
}
