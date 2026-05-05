export const safety = {
  autoStartWhatsApp: readFlag('ENABLE_WHATSAPP_CONNECTION', false),
  allowWriteActions: readFlag('ENABLE_WHATSAPP_WRITE_ACTIONS', false),
  allowPresenceActions: readFlag('ENABLE_WHATSAPP_PRESENCE_ACTIONS', false),
  syncFullHistory: readFlag('ENABLE_FULL_HISTORY_SYNC', false),
  downloadIncomingMedia: readFlag('ENABLE_INCOMING_MEDIA_DOWNLOADS', false)
};

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
