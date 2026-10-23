// Keeps screenshots within the library's 1 MB rule.

export const MAX_IMAGE_BYTES = 1024 * 1024;

export const formatBytes = (b) => (b >= MAX_IMAGE_BYTES
  ? `${(b / MAX_IMAGE_BYTES).toFixed(1)} MB`
  : `${Math.max(1, Math.round(b / 1024))} KB`);

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Returns { blob, ext, note }; files over 1 MB are re-encoded as WebP. */
export async function prepareImage(file) {
  if (file.size <= MAX_IMAGE_BYTES) return { blob: file, ext: EXTENSIONS[file.type] || 'png', note: '' };
  const webp = await toWebp(file);
  if (!webp || webp.size >= file.size) return { blob: file, ext: EXTENSIONS[file.type] || 'png', note: '' };
  return { blob: webp, ext: 'webp', note: `Converted to WebP, was ${formatBytes(file.size)}` };
}

// Tries quality 0.9, then 0.8 at shrinking sizes, until the file fits.
async function toWebp(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  let result = null;
  for (let attempt = 0, scale = 1; attempt < 6 && !(result?.size <= MAX_IMAGE_BYTES); attempt++) {
    if (attempt > 1) scale *= 0.8;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    result = await new Promise((r) => canvas.toBlob(r, 'image/webp', attempt === 0 ? 0.9 : 0.8));
    if (result?.type !== 'image/webp') { result = null; break; } // browser can't encode WebP
  }
  bitmap.close();
  return result;
}
