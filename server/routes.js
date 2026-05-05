import express from 'express';
import fs from 'fs/promises';
import multer from 'multer';
import path from 'path';
import { createPublicId, uploadLocalFile } from './cloudinary-storage.js';
import { getSafetySettings, safety, updateSafetySettings } from './safety.js';
import { backupDir, dataFile, uploadDir } from './storage-paths.js';

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_request, file, callback) => {
    const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    callback(null, `${Date.now()}-${safeOriginal}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 64 * 1024 * 1024
  }
});

export function createRoutes({ db, whatsapp }) {
  const router = express.Router();

  router.get('/status', (_request, response) => {
    response.json({
      ...whatsapp.getStatus(),
      safeMode: {
        autoStartWhatsApp: safety.autoStartWhatsApp,
        allowWriteActions: safety.allowWriteActions,
        allowPresenceActions: safety.allowPresenceActions,
        syncFullHistory: safety.syncFullHistory,
        downloadIncomingMedia: safety.downloadIncomingMedia
      }
    });
  });

  router.get('/admin/settings', (_request, response) => {
    response.json({
      ok: true,
      settings: getSafetySettings(),
      connected: whatsapp.getStatus().connected
    });
  });

  router.post('/admin/settings', async (request, response, next) => {
    try {
      const previousAutoStart = safety.autoStartWhatsApp;
      const settings = await updateSafetySettings(request.body || {});

      if (!previousAutoStart && settings.autoStartWhatsApp) {
        await whatsapp.start();
      }

      if (previousAutoStart && !settings.autoStartWhatsApp) {
        await whatsapp.stop();
      }

      response.json({
        ok: true,
        settings,
        connected: whatsapp.getStatus().connected
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/chats', async (_request, response, next) => {
    try {
      response.json(await db.getChats());
    } catch (error) {
      next(error);
    }
  });

  router.get('/messages/:jid', async (request, response, next) => {
    try {
      response.json(await db.getMessages(request.params.jid));
    } catch (error) {
      next(error);
    }
  });

  router.get('/search', async (request, response, next) => {
    try {
      response.json(await db.searchMessages(request.query.q, request.query.jid));
    } catch (error) {
      next(error);
    }
  });

  router.get('/chat-assets/:jid', async (request, response, next) => {
    try {
      response.json(await db.getChatAssets(request.params.jid));
    } catch (error) {
      next(error);
    }
  });

  router.get('/chat-info/:jid', async (request, response, next) => {
    try {
      response.json(await whatsapp.getChatInfo(request.params.jid));
    } catch (error) {
      next(error);
    }
  });

  router.get('/export/:format/:jid', async (request, response, next) => {
    try {
      const format = request.params.format;
      const jid = request.params.jid;
      const messages = await db.getMessages(jid);
      const fileBase = jid.replace(/[^a-zA-Z0-9._-]/g, '_');

      if (format === 'json') {
        response.setHeader('Content-Disposition', `attachment; filename="${fileBase}.json"`);
        return response.json(messages);
      }

      if (format === 'txt') {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Content-Disposition', `attachment; filename="${fileBase}.txt"`);
        return response.send(messages.map(formatMessageLine).join('\n'));
      }

      return response.status(400).json({ error: 'Unsupported export format.' });
    } catch (error) {
      next(error);
    }
  });

  router.get('/statuses', async (_request, response, next) => {
    try {
      response.json(await db.getStatuses());
    } catch (error) {
      next(error);
    }
  });

  router.post('/send-message', async (request, response, next) => {
    try {
      const { jid, text } = request.body;
      if (!jid || !text) {
        return response.status(400).json({ error: 'jid and text are required.' });
      }

      const message = await whatsapp.sendText(jid, text);
      response.json({ ok: true, message });
    } catch (error) {
      next(error);
    }
  });

  router.post('/chat-meta', async (request, response, next) => {
    try {
      const { jid, updates } = request.body;
      if (!jid || !updates) return response.status(400).json({ error: 'jid and updates are required.' });
      response.json({ ok: true, chat: await db.updateChatMeta(jid, updates) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/star-message', async (request, response, next) => {
    try {
      const { jid, messageId, starred } = request.body;
      if (!jid || !messageId) return response.status(400).json({ error: 'jid and messageId are required.' });
      response.json({ ok: true, message: await db.setMessageStarred(jid, messageId, starred) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/send-reaction', async (request, response, next) => {
    try {
      const { jid, messageId, text } = request.body;
      if (!jid || !messageId) return response.status(400).json({ error: 'jid and messageId are required.' });
      response.json({ ok: true, message: await whatsapp.sendReaction(jid, messageId, text || '') });
    } catch (error) {
      next(error);
    }
  });

  router.post('/presence', async (request, response, next) => {
    try {
      const { jid, type } = request.body;
      if (!jid || !type) return response.status(400).json({ error: 'jid and type are required.' });
      await whatsapp.sendPresence(jid, type);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/labels', async (_request, response, next) => {
    try {
      response.json(await db.getLabels());
    } catch (error) {
      next(error);
    }
  });

  router.post('/labels', async (request, response, next) => {
    try {
      response.json({ ok: true, label: await db.upsertLabel(request.body) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/reminders', async (_request, response, next) => {
    try {
      response.json(await db.getReminders());
    } catch (error) {
      next(error);
    }
  });

  router.post('/reminders', async (request, response, next) => {
    try {
      response.json({ ok: true, reminder: await db.addReminder(request.body) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/backup', async (_request, response, next) => {
    try {
      response.json({ ok: true, ...(await createDatabaseBackup()) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/backups', async (_request, response, next) => {
    try {
      response.json(await listBackups());
    } catch (error) {
      next(error);
    }
  });

  router.get('/admin/database/backups', async (_request, response, next) => {
    try {
      response.json({ ok: true, backups: await listBackups() });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/database/backup', async (_request, response, next) => {
    try {
      response.json({ ok: true, ...(await createDatabaseBackup()) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/admin/database/restore', async (request, response, next) => {
    try {
      const file = sanitizeBackupName(request.body?.file);
      if (!file) return response.status(400).json({ error: 'Valid backup file is required.' });

      await createDatabaseBackup('pre-restore');
      await fs.copyFile(path.join(backupDir, file), dataFile);
      await db.reload();
      response.json({ ok: true, file });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/admin/database', async (_request, response, next) => {
    try {
      const backup = await createDatabaseBackup('pre-delete');
      await db.clear();
      response.json({ ok: true, backup });
    } catch (error) {
      next(error);
    }
  });

  router.post('/send-media', upload.single('media'), async (request, response, next) => {
    try {
      const { jid, caption } = request.body;
      if (!jid) {
        return response.status(400).json({ error: 'jid is required.' });
      }

      const message = await whatsapp.sendMedia(jid, request.file, caption);
      response.json({ ok: true, message });
    } catch (error) {
      next(error);
    }
  });

  router.post('/logout', async (_request, response, next) => {
    try {
      await whatsapp.logout();
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;

  async function createDatabaseBackup(prefix = 'backup') {
    await fs.mkdir(backupDir, { recursive: true });
    const name = `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const backupPath = path.join(backupDir, name);
    await fs.copyFile(dataFile, backupPath);

    let cloudinary = null;
    try {
      cloudinary = await uploadLocalFile(backupPath, {
        folder: 'chat-backups',
        publicId: createPublicId(prefix, name),
        resourceType: 'raw',
        context: 'type=chat_backup'
      });
    } catch (error) {
      console.warn('Cloudinary backup upload failed:', error.message);
    }

    return { file: name, cloudinary };
  }

  async function listBackups() {
    await fs.mkdir(backupDir, { recursive: true });
    const files = await fs.readdir(backupDir);
    return files
      .filter((file) => file.endsWith('.json'))
      .sort()
      .reverse();
  }
}

function sanitizeBackupName(file = '') {
  const safe = path.basename(String(file));
  return safe.endsWith('.json') ? safe : '';
}

function formatMessageLine(message) {
  const time = new Date(Number(message.timestamp || Date.now())).toLocaleString();
  const sender = message.fromMe ? 'You' : message.senderName || message.senderJid || message.jid;
  const body = message.deleted
    ? '[deleted]'
    : message.text || message.fileName || message.mediaUrl || `[${message.type}]`;
  return `[${time}] ${sender}: ${body}`;
}
