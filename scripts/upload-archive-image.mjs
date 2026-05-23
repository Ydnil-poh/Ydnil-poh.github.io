import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [, , filePath, desiredName] = process.argv;
const supabaseUrl = process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'archive-images';

if (!filePath) {
  console.error('Usage: node scripts/upload-archive-image.mjs <image-file> [storage-name]');
  process.exit(1);
}

if (!supabaseUrl || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before uploading.');
  process.exit(1);
}

const cleanBase = (desiredName ?? basename(filePath)).replace(/[^A-Za-z0-9._/-]+/g, '-');
const storagePath = cleanBase.includes('/') ? cleanBase : `${new Date().toISOString().slice(0, 10)}/${cleanBase}`;
const endpoint = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/${bucket}/${storagePath}`;
const bytes = await readFile(filePath);

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'Content-Type': 'application/octet-stream',
    'x-upsert': 'true',
  },
  body: bytes,
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

const publicUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${storagePath}`;
console.log(`![archive image](${publicUrl})`);
