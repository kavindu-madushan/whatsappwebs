<<<<<<< HEAD
import fs from 'fs/promises';
import path from 'path';
import { settingsFile } from './storage-paths.js';

const DEFAULT_SAFETY = {
=======
export const safety = {
>>>>>>> 9d5d0b5eaa1d58db4f2702b4f82c6ee5d9c3a3f7
  autoStartWhatsApp: readFlag('ENABLE_WHATSAPP_CONNECTION', false),
  allowWriteActions: readFlag('ENABLE_WHATSAPP_WRITE_ACTIONS', false),
  allowPresenceActions: readFlag('ENABLE_WHATSAPP_PRESENCE_ACTIONS', false),
  syncFullHistory: readFlag('ENABLE_FULL_HISTORY_SYNC', false),
  downloadIncomingMedia: readFlag('ENABLE_INCOMING_MEDIA_DOWNLOADS', false)
};

<<<<<<< HEAD
export const safety = { ...DEFAULT_SAFETY };

export async function initSafetySettings() {
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });

  try {
    const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
    applySafetySettings(saved);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('Could not read admin settings, using safe defaults:', error.message);
    }
    await persistSafetySettings();
  }

  return getSafetySettings();
}

export function getSafetySettings() {
  return { ...safety };
}

export async function updateSafetySettings(updates = {}) {
  applySafetySettings(updates);
  await persistSafetySettings();
  return getSafetySettings();
}

=======
>>>>>>> 9d5d0b5eaa1d58db4f2702b4f82c6ee5d9c3a3f7
export function assertAllowed(allowed, message) {
  if (!allowed) {
    const error = new Error(message);
    error.statusCode = 403;
    throw error;
  }
}

function readFlag(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}
<<<<<<< HEAD

function applySafetySettings(updates = {}) {
  for (const key of Object.keys(DEFAULT_SAFETY)) {
    if (Object.hasOwn(updates, key)) {
      safety[key] = Boolean(updates[key]);
    }
  }
}

async function persistSafetySettings() {
  await fs.writeFile(settingsFile, JSON.stringify(getSafetySettings(), null, 2));
}
=======
>>>>>>> 9d5d0b5eaa1d58db4f2702b4f82c6ee5d9c3a3f7
