import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PAGE_SIZE = 4096;
export const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

const HMAC_ALGOS = {
  80: { hash: "sha512", hmacSize: 64 }, // SQLCipher4: nonce 16 + HMAC-SHA512 64
  48: { hash: "sha256", hmacSize: 32 }, // nonce 16 + HMAC-SHA256 32
  36: { hash: "sha1", hmacSize: 20 },   // nonce 16 + HMAC-SHA1 20
};

function pbkdf2(password, salt, iterations, keylen, digest) {
  return crypto.pbkdf2Sync(password, salt, iterations, keylen, digest);
}

function macKeyFor(encKey, salt, hash) {
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a));
  return pbkdf2(encKey, macSalt, 2, 32, hash);
}

function pageHmac(encKeyBuf, pageData, pgno, reserve) {
  const { hash, hmacSize } = HMAC_ALGOS[reserve];
  const salt = pageData.subarray(0, 16);
  const macKey = macKeyFor(encKeyBuf, salt, hash);
  const nonceStart = PAGE_SIZE - reserve;
  const mac = crypto.createHmac(hash, macKey);
  const offset = pgno === 1 ? 16 : 0;
  mac.update(pageData.subarray(offset, nonceStart + 16));
  const pgnoBuf = Buffer.alloc(4);
  pgnoBuf.writeUInt32LE(pgno);
  mac.update(pgnoBuf);
  const digest = mac.digest();
  return digest.subarray(0, hmacSize);
}

export function headerLooksValid(plain) {
  if (plain.length < 24) return false;
  const pageSize = (plain[16] << 8) | plain[17];
  const validPageSize =
    pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0;
  const wv = plain[18];
  const rv = plain[19];
  return (
    validPageSize &&
    (wv === 1 || wv === 2) &&
    (rv === 1 || rv === 2) &&
    plain[21] === 0x40 &&
    plain[22] === 0x20 &&
    plain[23] === 0x20
  );
}

/** Decrypt page 1 and return the plaintext header (or null). */
function tryHeader(encKeyBuf, page1, reserve) {
  if (page1.length < PAGE_SIZE) return null;
  const nonceStart = PAGE_SIZE - reserve;
  const nonce = page1.subarray(nonceStart, nonceStart + 16);
  const ciphertext = page1.subarray(16, nonceStart);
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", encKeyBuf, nonce);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const header = Buffer.concat([SQLITE_MAGIC, plain]);
    return headerLooksValid(header) ? header : null;
  } catch {
    return null;
  }
}

/** Detect the SQLCipher page reserve size and verify the key via HMAC. */
export function detectCipher(encKeyBuf, page1) {
  for (const reserve of [80, 48, 36]) {
    const header = tryHeader(encKeyBuf, page1, reserve);
    if (!header) continue;
    const expected = pageHmac(encKeyBuf, page1, 1, reserve);
    const stored = page1.subarray(PAGE_SIZE - reserve + 16);
    if (expected.equals(stored)) {
      return { reserve, ...HMAC_ALGOS[reserve] };
    }
  }
  return null;
}

/** Decrypt one encrypted SQLCipher database file to a plain SQLite file. */
export function decryptDatabase(srcPath, dstPath, encKeyHex) {
  const src = fs.readFileSync(srcPath);
  if (src.length < PAGE_SIZE) throw new Error("file too small");
  const encKeyBuf = Buffer.from(encKeyHex, "hex");
  if (encKeyBuf.length !== 32) throw new Error("bad key length");

  const page1 = src.subarray(0, PAGE_SIZE);
  const cipher = detectCipher(encKeyBuf, page1);
  if (!cipher) throw new Error("key/page format did not verify");
  const { reserve } = cipher;
  const payloadEnd = PAGE_SIZE - reserve;
  const totalPages = Math.ceil(src.length / PAGE_SIZE);
  const out = Buffer.alloc(totalPages * PAGE_SIZE);

  for (let pgno = 1; pgno <= totalPages; pgno++) {
    const start = (pgno - 1) * PAGE_SIZE;
    const page = src.subarray(start, Math.min(start + PAGE_SIZE, src.length));
    const padded = Buffer.alloc(PAGE_SIZE);
    page.copy(padded);
    const nonce = padded.subarray(payloadEnd, payloadEnd + 16);
    const offset = pgno === 1 ? 16 : 0;
    const decipher = crypto.createDecipheriv("aes-256-cbc", encKeyBuf, nonce);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([
      decipher.update(padded.subarray(offset, payloadEnd)),
      decipher.final(),
    ]);
    const outStart = start;
    if (pgno === 1) {
      SQLITE_MAGIC.copy(out, outStart);
      plain.copy(out, outStart + 16);
    } else {
      plain.copy(out, outStart);
    }
    // Reserved bytes stay zero: SQLite never uses them.
  }

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const tmp = dstPath + ".tmp";
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, dstPath);
  return { pages: totalPages, reserve };
}
