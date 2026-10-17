import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptDatabase } from "./sqlcipher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const KEYS_PATH = path.join(DATA_DIR, "keys.json");
const OUT_DIR = path.join(DATA_DIR, "decrypted");
const MANIFEST_PATH = path.join(DATA_DIR, "decrypt-manifest.json");

export function loadKeys() {
  if (!fs.existsSync(KEYS_PATH)) {
    throw new Error(
      `keys.json not found at ${KEYS_PATH}. Run tools\\wechat-keys.exe first (WeChat must be running and logged in).`,
    );
  }
  return JSON.parse(fs.readFileSync(KEYS_PATH, "utf8"));
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeManifest(manifest) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

/**
 * Decrypt every database listed in keys.json into data/decrypted.
 * Re-decrypts a database when its source size or mtime changed.
 */
export function decryptAll({ force = false, log = console.log } = {}) {
  const { db_dir: dbDir, keys } = loadKeys();
  const manifest = readManifest();
  const stats = { decrypted: 0, skipped: 0, failed: 0, failedFiles: [] };

  for (const [rel, info] of Object.entries(keys)) {
    const src = path.join(dbDir, rel);
    const dst = path.join(OUT_DIR, rel);
    if (!fs.existsSync(src)) {
      stats.failed++;
      stats.failedFiles.push(rel + " (missing)");
      continue;
    }
    const st = fs.statSync(src);
    const fingerprint = `${st.size}:${Math.floor(st.mtimeMs)}`;
    const prev = manifest[rel];
    const upToDate =
      !force &&
      prev &&
      prev.fingerprint === fingerprint &&
      prev.key === info.enc_key &&
      fs.existsSync(dst) &&
      fs.statSync(dst).size === Math.ceil(st.size / 4096) * 4096;

    if (upToDate) {
      stats.skipped++;
      continue;
    }

    try {
      const result = decryptDatabase(src, dst, info.enc_key);
      manifest[rel] = { fingerprint, key: info.enc_key, pages: result.pages, reserve: result.reserve };
      stats.decrypted++;
      log(`[decrypt] ${rel} (${result.pages} pages, reserve ${result.reserve})`);
    } catch (error) {
      stats.failed++;
      stats.failedFiles.push(`${rel}: ${error.message}`);
      log(`[decrypt] FAILED ${rel}: ${error.message}`);
    }
  }
  writeManifest(manifest);
  log(
    `[decrypt] done: ${stats.decrypted} decrypted, ${stats.skipped} unchanged, ${stats.failed} failed`,
  );
  return stats;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const force = process.argv.includes("--force");
  decryptAll({ force });
}
