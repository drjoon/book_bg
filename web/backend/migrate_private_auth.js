import connectDB from "./db.js";
import { User } from "./models.js";
import { encryptCredential, looksEncryptedCredential } from "./crypto.js";

const ADMIN_USERNAME = "drjoon";
const ADMIN_INITIAL_PASSWORD = "*0987";

async function migratePrivateAuth() {
  await connectDB();

  const users = await User.find({});
  let updatedCount = 0;

  for (const user of users) {
    let shouldSave = false;

    if (typeof user.debeachLoginId !== "string") {
      user.debeachLoginId = user.name === ADMIN_USERNAME ? "admin" : "";
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

    if (user.name === ADMIN_USERNAME) {
      if (user.role !== "admin") {
        user.role = "admin";
        shouldSave = true;
      }
      if (!user.granted) {
        user.granted = true;
        shouldSave = true;
      }
      if (!user.debeachLoginId) {
        user.debeachLoginId = "admin";
        shouldSave = true;
      }
    }

    if (shouldSave) {
      await user.save();
      updatedCount += 1;
      console.log(`[MIGRATE_PRIVATE_AUTH] updated ${user.name}`);
    }
  }

  const admin = await User.findOne({ name: ADMIN_USERNAME, role: "admin" });
  if (!admin) {
    const created = new User({
      name: "drjoon",
      password: ADMIN_INITIAL_PASSWORD,
      debeachLoginId: "admin",
      debeachLoginPassword: encryptCredential(""),
      role: "admin",
      granted: true,
    });
    await created.save();
    updatedCount += 1;
    console.log(`[MIGRATE_PRIVATE_AUTH] created ${ADMIN_USERNAME}`);
  }

  console.log(`[MIGRATE_PRIVATE_AUTH] done. updated=${updatedCount}`);
}

migratePrivateAuth()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[MIGRATE_PRIVATE_AUTH] failed:", error);
    process.exit(1);
  });
