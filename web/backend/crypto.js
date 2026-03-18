import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const secret = process.env.DEBEACH_CREDENTIAL_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("Missing DEBEACH_CREDENTIAL_SECRET or JWT_SECRET for credential encryption.");
  }
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptCredential(plainText) {
  if (!plainText) return "";
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptCredential(cipherText) {
  if (!cipherText) return "";
  const payload = Buffer.from(cipherText, "base64");
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, getEncryptionKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function looksEncryptedCredential(value) {
  if (!value) return false;
  try {
    decryptCredential(value);
    return true;
  } catch {
    return false;
  }
}
