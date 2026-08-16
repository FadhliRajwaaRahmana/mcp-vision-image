import fs from 'fs';
import path from 'path';

/**
 * Mendapatkan mime-type dari ekstensi file atau Content-Type header
 */
function getMimeType(filePathOrUrl, contentTypeHeader = null) {
  if (contentTypeHeader && contentTypeHeader.startsWith('image/')) {
    return contentTypeHeader.split(';')[0].trim();
  }

  const ext = path.extname(filePathOrUrl).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'image/jpeg';
  }
}

/**
 * Membaca gambar dari file path atau URL dan mengembalikan { mimeType, base64Data }
 */
export async function processImageSource(source) {
  if (!source || typeof source !== 'string') {
    throw new Error('Image source harus berupa string path file lokal atau URL http(s)');
  }

  const trimmed = source.trim();

  // Kasus 1: URL http:// atau https://
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const res = await fetch(trimmed, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`Gagal mendownload gambar dari URL (${res.status} ${res.statusText}): ${trimmed}`);
    }

    const contentType = res.headers.get('content-type');
    const mimeType = getMimeType(trimmed, contentType);
    const arrayBuffer = await res.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');

    return { mimeType, base64Data };
  }

  // Kasus 2: Path File Lokal
  // Hapus kutipan jika user menyertakan "path/to/file"
  const cleanPath = trimmed.replace(/^["']|["']$/g, '');

  if (!fs.existsSync(cleanPath)) {
    throw new Error(`File gambar tidak ditemukan di path: "${cleanPath}"`);
  }

  const mimeType = getMimeType(cleanPath);
  const buffer = fs.readFileSync(cleanPath);
  const base64Data = buffer.toString('base64');

  return { mimeType, base64Data };
}
