// Image storage helper.
//
// In production (Vercel) the filesystem is read-only, so uploaded images are
// pushed to a public Supabase Storage bucket and the public URL is stored.
// When Supabase env vars are not set (e.g. local dev), images fall back to
// the local `public/uploads` directory so behavior is unchanged offline.

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'listings';

// On-upload image optimization: resize oversized photos and re-encode to WebP so
// the bucket stays small. Tunable via env. Only raster photos are converted;
// SVG/GIF pass through untouched (vector / animation would be lost).
const IMAGE_MAX_WIDTH = parseInt(process.env.IMAGE_MAX_WIDTH || '2000', 10);
const IMAGE_WEBP_QUALITY = parseInt(process.env.IMAGE_WEBP_QUALITY || '80', 10);
const OPTIMIZABLE_MIME = /^image\/(jpeg|png|webp)$/i;

// Returns { buffer, ext, contentType }. Falls back to the original bytes on any
// failure or for non-convertible types, so uploads never break.
async function optimizeImage(file) {
  if (!file || !OPTIMIZABLE_MIME.test(file.mimetype || '')) {
    return { buffer: file.buffer, ext: path.extname(file.originalname || ''), contentType: file.mimetype };
  }
  try {
    const buffer = await sharp(file.buffer, { failOn: 'none' })
      .rotate() // bake EXIF orientation before resizing
      .resize({ width: IMAGE_MAX_WIDTH, height: IMAGE_MAX_WIDTH, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: IMAGE_WEBP_QUALITY })
      .toBuffer();
    return { buffer, ext: '.webp', contentType: 'image/webp' };
  } catch (err) {
    console.warn('[storage] image optimization failed, storing original:', err.message);
    return { buffer: file.buffer, ext: path.extname(file.originalname || ''), contentType: file.mimetype };
  }
}

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

function uniqueName(originalName) {
  return Date.now() + '-' + Math.round(Math.random() * 1e6) + path.extname(originalName || '');
}

// Persist a single in-memory multer file and return a URL/path string
// suitable for storing in the `listings.images` / `floor_plan_image` columns.
// Photos are optimized (resized + WebP) before upload.
async function storeImage(file) {
  const { buffer, ext, contentType } = await optimizeImage(file);
  const name = Date.now() + '-' + Math.round(Math.random() * 1e6) + (ext || '');

  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(name, buffer, {
      contentType,
      upsert: false
    });
    if (error) throw new Error('Supabase Storage upload failed: ' + error.message);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(name);
    return data.publicUrl;
  }

  // Local fallback
  const dir = path.join(__dirname, '..', 'public', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buffer);
  return '/uploads/' + name;
}

// Private bucket for sensitive uploads (e.g. applicant photo IDs). Never public —
// objects are retrieved by admins via short-lived signed URLs. Stores and returns
// the object *path* (not a public URL).
//
// The files themselves are kept forever: nothing here or elsewhere deletes or
// expires them. Only the signed *view links* are short-lived, and a new one is
// minted each time an admin opens an ID (see /admin/paid-applications/:id/id/:side).
const PRIVATE_BUCKET = process.env.SUPABASE_PRIVATE_BUCKET || 'applicant-ids';

async function storePrivateFile(file, prefix) {
  const name = (prefix ? prefix.replace(/[^a-z0-9/_-]/gi, '') + '/' : '') + uniqueName(file.originalname);
  if (supabase) {
    const { error } = await supabase.storage.from(PRIVATE_BUCKET).upload(name, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });
    if (error) throw new Error('Private upload failed: ' + error.message);
    return name; // store the object path; resolve to a signed URL on demand
  }
  // Local fallback (dev only) — keep IDs out of the public uploads dir.
  const dir = path.join(__dirname, '..', 'private_uploads');
  fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), file.buffer);
  return 'local:' + name;
}

// Resolve a stored private path to a temporary signed URL (default 7 days).
async function signedPrivateUrl(objectPath, expiresInSeconds = 7 * 24 * 60 * 60) {
  if (!objectPath || objectPath.startsWith('local:')) return null;
  if (!supabase) return null;
  const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(objectPath, expiresInSeconds);
  if (error) return null;
  return data.signedUrl;
}

module.exports = { storeImage, storePrivateFile, signedPrivateUrl, storageEnabled: !!supabase, PRIVATE_BUCKET };
