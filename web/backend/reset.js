import bcrypt from "bcrypt";

import connectDB from "./db.js";
import { User } from "./models.js";

const [username, newPassword] = process.argv.slice(2);

if (!username || !newPassword) {
  console.error("Usage: node reset.js <username> <newPassword>");
  process.exit(1);
}

const main = async () => {
  try {
    await connectDB();

    const password = await bcrypt.hash(newPassword, 10);
    const user = await User.findOneAndUpdate(
      { username },
      { $set: { password, golfPassword: newPassword } },
      { new: true },
    );

    if (!user) {
      console.error(`User not found: ${username}`);
      process.exit(1);
    }

    console.log(`Password updated for ${user.username}`);
    process.exit(0);
  } catch (error) {
    console.error("Failed to update password:", error);
    process.exit(1);
  }
};

await main();
