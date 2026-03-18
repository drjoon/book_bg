import fs from "fs/promises";
import path from "path";

import connectDB from "./db.js";
import { User } from "./models.js";
import { encryptCredential, looksEncryptedCredential } from "./crypto.js";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOOKING_CONFIG_PATH = path.resolve(
  __dirname,
  "../../auto/booking_configs.json",
);

async function migratePrivateAuth() {
  await connectDB();

  const legacyConfigs = JSON.parse(
    await fs.readFile(BOOKING_CONFIG_PATH, "utf-8"),
  );
  const legacyConfigMap = new Map(
    legacyConfigs.map((config) => [String(config.NAME || "").trim(), config]),
  );

  const users = await User.find({});
  let updatedCount = 0;

  for (const user of users) {
    let shouldSave = false;
    const legacyConfig = legacyConfigMap.get(String(user.name || "").trim());

    if (typeof user.debeachLoginId !== "string") {
      user.debeachLoginId = "";
      shouldSave = true;
    }

    if (typeof user.debeachLoginPassword !== "string") {
      user.debeachLoginPassword = "";
      shouldSave = true;
    }

    if (
      user.debeachLoginPassword &&
      !looksEncryptedCredential(user.debeachLoginPassword)
    ) {
      user.debeachLoginPassword = encryptCredential(user.debeachLoginPassword);
      shouldSave = true;
    }

    if (legacyConfig) {
      const nextLoginId = String(legacyConfig.LOGIN_ID || "").trim();
      const nextLoginPassword = String(
        legacyConfig.LOGIN_PASSWORD || "",
      ).trim();

      if (nextLoginId && user.debeachLoginId !== nextLoginId) {
        user.debeachLoginId = nextLoginId;
        shouldSave = true;
      }

      const encryptedLegacyPassword = nextLoginPassword
        ? encryptCredential(nextLoginPassword)
        : "";
      if (
        encryptedLegacyPassword &&
        user.debeachLoginPassword !== encryptedLegacyPassword
      ) {
        user.debeachLoginPassword = encryptedLegacyPassword;
        shouldSave = true;
      }
    }

    if (shouldSave) {
      await user.save();
      updatedCount += 1;
      console.log(`[MIGRATE_PRIVATE_AUTH] updated ${user.name}`);
    }
  }

  console.log(`[MIGRATE_PRIVATE_AUTH] done. updated=${updatedCount}`);
}

migratePrivateAuth()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[MIGRATE_PRIVATE_AUTH] failed:", error);
    process.exit(1);
  });
