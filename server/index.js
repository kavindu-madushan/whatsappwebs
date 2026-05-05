import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import { JsonDatabase } from './database.js';
import { createRoutes } from './routes.js';
import { setupSocket } from './socket.js';
import { dataFile, uploadDir } from './storage-paths.js';
import { WhatsAppService } from './whatsapp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const db = new JsonDatabase(dataFile);
await db.init();

setupSocket(io);

const whatsapp = new WhatsAppService(db);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.get(['/health', '/api/health'], (_request, response) => {
  response.json({
    ok: true,
    connected: whatsapp.getStatus().connected
  });
});
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(rootDir, 'public')));
app.use('/api', createRoutes({ db, whatsapp }));

app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({
    error: error.message || 'Internal server error'
  });
});

server.listen(port, host, async () => {
  console.log(`WhatsApp Web System running on ${host}:${port}`);
  try {
    await whatsapp.start();
  } catch (error) {
    console.error('Failed to start WhatsApp service:', error);
  }
});
