let ioInstance = null;

export function setupSocket(io) {
  ioInstance = io;

  io.on('connection', (socket) => {
    socket.emit('ready', { ok: true });
  });

  return ioInstance;
}

export function emitSocket(event, payload) {
  if (ioInstance) {
    ioInstance.emit(event, payload);
  }
}

export function getSocket() {
  return ioInstance;
}
