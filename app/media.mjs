import fs from "node:fs";
import path from "node:path";

function wrapWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

let silkDecoder = null;
async function getSilkDecoder() {
  if (!silkDecoder) {
    try {
      silkDecoder = await import("silk-wasm");
    } catch (error) {
      throw new Error(`silk-wasm is not installed: ${error.message}`);
    }
  }
  return silkDecoder;
}

/** Convert WeChat SILK voice data to WAV (24000 Hz mono 16-bit), with disk cache. */
export async function silkToWav(silkBuffer, cachePath) {
  if (fs.existsSync(cachePath)) return cachePath;
  const silk = await getSilkDecoder();
  let decoded;
  try {
    decoded = await silk.decode(silkBuffer, 24000);
  } catch {
    // Some records carry a 3-byte 0x02 '#!' prefix already; retry raw payload.
    const payload = silkBuffer.subarray(3);
    decoded = await silk.decode(payload, 24000);
  }
  const pcm = Buffer.isBuffer(decoded.data) ? decoded.data : Buffer.from(decoded.data);
  const wav = wrapWav(pcm, 24000, 1, 16);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = cachePath + ".tmp";
  fs.writeFileSync(tmp, wav);
  fs.renameSync(tmp, cachePath);
  return cachePath;
}

export function wavDataUri(wavBuffer) {
  return "data:audio/wav;base64," + wavBuffer.toString("base64");
}

export function imageDataUri(buf, contentType) {
  return `data:${contentType};base64,${buf.toString("base64")}`;
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
