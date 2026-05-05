import { v2 as cloudinary } from 'cloudinary';
import path from 'path';
import { Readable } from 'stream';

const CLOUDINARY_ROOT_FOLDER = process.env.CLOUDINARY_ROOT_FOLDER || 'whatsapp-web-system';

let configured = false;

function configure() {
  if (configured) return true;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return false;
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true
  });
  configured = true;
  return true;
}

export function isCloudinaryEnabled() {
  return configure();
}

export async function uploadLocalFile(filePath, options = {}) {
  if (!configure()) return null;

  return normalizeUploadResult(await cloudinary.uploader.upload(filePath, {
    folder: buildFolder(options.folder),
    public_id: options.publicId,
    resource_type: options.resourceType || 'auto',
    context: options.context
  }));
}

export async function uploadBuffer(buffer, options = {}) {
  if (!configure()) return null;

  const uploadOptions = {
    folder: buildFolder(options.folder),
    public_id: options.publicId,
    resource_type: options.resourceType || 'auto',
    context: options.context
  };

  return normalizeUploadResult(await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });

    Readable.from([buffer]).pipe(stream);
  }));
}

export function createPublicId(...parts) {
  return parts
    .filter(Boolean)
    .map((part) => String(part).replace(/\.[a-zA-Z0-9]+$/, '').replace(/[^a-zA-Z0-9._-]/g, '_'))
    .filter(Boolean)
    .join('-')
    .slice(0, 180);
}

function buildFolder(folder = '') {
  return [CLOUDINARY_ROOT_FOLDER, folder]
    .filter(Boolean)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
}

function normalizeUploadResult(result) {
  if (!result) return null;

  return {
    publicId: result.public_id,
    resourceType: result.resource_type,
    url: result.secure_url || result.url,
    bytes: result.bytes,
    format: result.format,
    createdAt: result.created_at
  };
}
