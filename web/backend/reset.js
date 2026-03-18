import bcrypt from "bcrypt";

import connectDB from "./db.js";
import { User } from "./models.js";

const [name, newPassword] = process.argv.slice(2);

if (!name || !newPassword) {
  console.error("Usage: node reset.js <name> <newPassword>");
  process.exit(1);
}

const main = async () => {
  try {
    await connectDB();

    const password = await bcrypt.hash(newPassword, 10);
    const user = await User.findOneAndUpdate(
      { name },
      { $set: { password } },
      { new: true },
    );

    if (!user) {
      console.error(`User not found: ${name}`);
      process.exit(1);
    }

    console.log(`Password updated for ${user.name}`);
    process.exit(0);
  } catch (error) {
    console.error("Failed to update password:", error);
    process.exit(1);
  }
};

await main();
