# WhatsApp Web System

A local WhatsApp Web style dashboard for personal or explicitly authorized WhatsApp account management. It uses Node.js, Express, Socket.IO, Baileys, and JSON file storage.

This project intentionally does not include bulk messaging, scraping, spam tooling, campaign tooling, or abusive automation features.

## Stack

- Backend: Node.js and Express
- WhatsApp connection: Baileys
- Realtime UI: Socket.IO
- Frontend: HTML, CSS, and JavaScript
- Storage: JSON file storage at `server/data/whatsapp.json`
- Cloud media storage: Cloudinary when configured
- Auth session: Baileys multi-file auth at `server/auth_info_baileys`

## Baileys Version

This project pins `@whiskeysockets/baileys@6.7.19`, which npm lists as the latest stable `latest` tag as of May 2026. If Baileys introduces breaking changes later, keep this pinned version until you intentionally test and update the connection code.

## Install

```bash
npm install
```

## Run

```bash
npm start
```

Open:

```text
http://localhost:3000
```

## Cloudinary

Cloudinary is optional. When configured, the app uploads:

- Chat backups from `POST /api/backup` as raw JSON files
- Incoming chat images, videos, audio, and documents
- Incoming status images, videos, and audio
- Outgoing media sent through the UI

Local files are still saved first so WhatsApp sending and local fallback keep working. Add these values to a local `.env` file:

```bash
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_ROOT_FOLDER=whatsapp-web-system
```

`CLOUDINARY_CLOUD_NAME` is required in addition to the API key and API secret.

## Railway Deploy

Railway is a good deployment target for this app because it can run the long-lived Node process that Baileys needs for the WhatsApp connection.

Recommended Railway setup:

1. Push this folder to GitHub.
2. Create a Railway project from the GitHub repository.
3. Add a persistent volume to the web service.
4. Mount the volume at:

```text
/app/.data
```

5. Add these Railway variables:

```bash
APP_DATA_DIR=/app/.data
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_ROOT_FOLDER=whatsapp-web-system
```

6. In Railway Networking, generate a public domain.
7. Open the Railway URL and scan the WhatsApp QR code.

The included `railway.json` sets `npm start` as the start command and `/health` as the deployment healthcheck. Railway injects `PORT`, and the app already listens on it.

With `APP_DATA_DIR=/app/.data`, these files persist on the Railway volume:

- Baileys auth session
- JSON database
- Backups
- Local upload cache and avatars

## Login

1. Start the server.
2. Open the web UI.
3. Scan the QR code with WhatsApp on your phone.
4. The auth session is saved in `server/auth_info_baileys`.
5. On the next server restart, Baileys will reuse the saved session and reconnect automatically when possible.

## API Endpoints

- `GET /api/status`
- `GET /api/chats`
- `GET /api/messages/:jid`
- `POST /api/send-message`
- `POST /api/send-media`
- `POST /api/logout`

## Socket.IO Events

The server emits:

- `qr`
- `connected`
- `disconnected`
- `chats`
- `new-message`
- `message-sent`

## Media

The UI supports sending:

- Images
- Documents, including PDF
- Audio files when WhatsApp and Baileys accept the uploaded format

Incoming supported media is saved into `uploads/` when Baileys can download it. Image previews are shown in the chat area.

## Storage

Chats and messages are stored in JSON:

```text
server/data/whatsapp.json
```

Saved message fields include:

- Message ID
- Chat JID
- Sender JID
- Receiver JID
- Direction
- Message type
- Text/caption
- Media path
- Timestamp

Duplicate messages are avoided by checking the Baileys message ID within each chat.

## Notes

- Use only accounts and chats you own or are authorized to manage.
- WhatsApp may change its web protocol. Baileys can break when WhatsApp changes upstream behavior.
- Do not use this project for spam, scraping, harassment, or unauthorized automation.
- The app is intended to run locally. Add authentication and HTTPS before exposing it to any network.
