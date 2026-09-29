import { connectDb, disconnectDb } from "../src/config/db.js";
import { User } from "../src/models/index.js";

async function main() {
  await connectDb();
  console.log("Syncing top-level expiredAt for all users...");
  const users = await User.find();
  let updated = 0;
  for (const u of users) {
    if (u.license?.expiredAt) {
      u.expiredAt = u.license.expiredAt;
      await u.save();
      updated++;
    }
  }
  console.log(`Synced ${updated} users with top-level expiredAt.`);
  await disconnectDb();
}

main().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
