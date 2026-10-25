// Small thumbnails of case screenshots. Each is made once from the full
// image and kept in the browser, keyed by the file's git blob id, so it
// can never go stale and later visits don't download anything.

const CACHE = 'case-thumbnails-v1';
const WIDTH = 480; // 2× the widest card
const urls = new Map(); // blob id → Promise<object URL>

/** The thumbnail's URL if it is already loaded, for rendering without a flash. */
export const readyThumbnail = (oid) => urls.get(oid)?.ready;

/** Thumbnail URL for blob `oid`; `download()` fetches the full image when needed. */
export function thumbnail(oid, download) {
  if (!urls.has(oid)) {
    const pending = load(oid, download).then((url) => (pending.ready = url));
    pending.catch(() => urls.delete(oid)); // try again next time
    urls.set(oid, pending);
  }
  return urls.get(oid);
}

async function load(oid, download) {
  const key = `https://thumbnails.invalid/${oid}`; // the Cache API needs a URL key
  let cache;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return URL.createObjectURL(await hit.blob());
  } catch { /* storage unavailable: work without it */ }
  const small = await shrink(await download());
  await cache?.put(key, new Response(small)).catch(() => {});
  return URL.createObjectURL(small);
}

async function shrink(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return (await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.8))) || blob;
}
