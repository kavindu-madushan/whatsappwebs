import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const runtimeDataDir = process.env.APP_DATA_DIR ? path.resolve(process.env.APP_DATA_DIR) : '';

export const uploadDir = runtimeDataDir
  ? path.join(runtimeDataDir, 'uploads')
  : path.join(rootDir, 'uploads');

export const backupDir = runtimeDataDir
  ? path.join(runtimeDataDir, 'backups')
  : path.join(__dirname, 'backups');

export const dataFile = runtimeDataDir
  ? path.join(runtimeDataDir, 'data', 'whatsapp.json')
  : path.join(__dirname, 'data', 'whatsapp.json');

export const authDir = runtimeDataDir
  ? path.join(runtimeDataDir, 'auth_info_baileys')
  : path.join(__dirname, 'auth_info_baileys');

export const avatarDir = path.join(uploadDir, 'avatars');
