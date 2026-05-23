import { createReadStream } from 'node:fs';
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

const form = new FormData();
const file = await import('node:fs/promises').then((fs) => fs.open(filePath, 'r')).then(async (handle) => {
  await handle.close();
  return createReadStream(filePath);
});
form.append('file', new Blob([await new Response(file).arrayBuffer()]), basename(storagePath));

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${serviceKey}`,
    apikey: serviceKey,
    'x-upsert': 'true',
  },
  body: form,
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

const publicUrl = `${supabaseUrl.replace(/\/$/, '')}/storage/v1/object/public/${bucket}/${storagePath}`;
console.log(`![archive image](${publicUrl})`);
