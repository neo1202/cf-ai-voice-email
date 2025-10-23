// src/lib/utils.ts

export function b64ToBlob(b64: string, mime: string): Blob {
  const i = b64.indexOf(","); // handles data:audio/mpeg;base64,XXX too
  const clean = i >= 0 ? b64.slice(i + 1) : b64;
  const bin = atob(clean);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

export function sniffAudioMime(b64: string): string {
  const head = b64.slice(0, 8);
  // WAV often starts with "RIFF" -> base64 "UklGR"
  if (head.startsWith("UklGR")) return "audio/wav";
  // MP3 with ID3 tag often starts "ID3" -> base64 "SUQz"
  if (head.startsWith("SUQz") || b64.startsWith("/+")) return "audio/mpeg";
  return "audio/mpeg";
}

export function waitForOpen(ws: WebSocket, timeoutMs = 5000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("WS open timeout"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new Error("WS error before open"));
    };
    const cleanup = () => {
      clearTimeout(t);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onErr);
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onErr);
  });
}

export function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 15000,
  checkMs = 50
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - t0 > timeoutMs)
        return reject(new Error(`${label} timeout`));
      setTimeout(tick, checkMs);
    };
    tick();
  });
}