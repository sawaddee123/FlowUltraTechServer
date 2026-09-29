import express, { type Router, type Request, type Response } from "express";
import { authenticateToken } from "../middlewares/auth.js";
import { InstanceProfile, type IInstanceProfile } from "../models/InstanceProfile.js";
import { User, type UserDocument } from "../models/User.js";

export const profilesRouter: Router = express.Router();

profilesRouter.use(authenticateToken);

// Helper to sanitize numeric userId
const getUserId = (req: Request): number => {
  return typeof req.userId === "number" ? req.userId : Number(req.userId);
};

// GET /api/v1/profiles - List all instance profiles for the user
profilesRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const profiles = await InstanceProfile.find({ userId }).sort({ profileFolderName: 1 }).lean();
    res.json({
      success: true,
      count: profiles.length,
      profiles,
    });
  } catch (error) {
    console.error("[profiles:list] Error fetching profiles:", error);
    res.status(500).json({ error: "Internal server error fetching profiles" });
  }
});

// POST /api/v1/profiles - Create or Upsert a single profile
profilesRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    clientProfileId,
    name,
    profileFolderName,
    cdpPort,
    launchMode = "DirectProfile",
    proxyId = null,
    streamerUsername = "",
    customChromiumFlags = "",
    tiktokAccount,
    rules = [],
  } = req.body ?? {};

  if (!profileFolderName || !name) {
    res.status(400).json({ error: "name and profileFolderName are required" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const folderClean = String(profileFolderName).trim();
    const updateData: Partial<IInstanceProfile> = {
      userRef: user._id,
      userId: user.userId,
      name: String(name).trim(),
      profileFolderName: folderClean,
      cdpPort: Number(cdpPort) || 9221,
      launchMode: launchMode === "Sandboxie" ? "Sandboxie" : "DirectProfile",
      proxyId: proxyId || null,
      streamerUsername: String(streamerUsername || "").trim(),
      customChromiumFlags: String(customChromiumFlags || ""),
    };

    if (clientProfileId) {
      updateData.clientProfileId = String(clientProfileId).trim();
    }

    if (tiktokAccount && typeof tiktokAccount === "object") {
      updateData.tiktokAccount = {
        isLoggedIn: Boolean(tiktokAccount.isLoggedIn),
        tiktokUid: tiktokAccount.tiktokUid ? String(tiktokAccount.tiktokUid) : null,
        displayId: tiktokAccount.displayId ? String(tiktokAccount.displayId) : null,
        nickname: tiktokAccount.nickname ? String(tiktokAccount.nickname) : null,
        avatarUrl: tiktokAccount.avatarUrl ? String(tiktokAccount.avatarUrl) : null,
        lastSyncAt: new Date(),
      };
    }

    if (Array.isArray(rules)) {
      updateData.rules = rules;
    }

    const profile = await InstanceProfile.findOneAndUpdate(
      { userId, profileFolderName: folderClean },
      { $set: updateData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      message: "Profile saved successfully",
      profile,
    });
  } catch (error) {
    console.error("[profiles:create] Error saving profile:", error);
    res.status(500).json({ error: "Internal server error saving profile" });
  }
});

// DELETE /api/v1/profiles/:folderName - Delete a profile
profilesRouter.delete("/:folderName", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  const folderName = req.params.folderName?.trim();

  if (isNaN(userId) || !folderName) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  try {
    const result = await InstanceProfile.findOneAndDelete({
      userId,
      profileFolderName: folderName,
    });

    if (!result) {
      res.status(404).json({ error: "Profile not found" });
      return;
    }

    res.json({
      success: true,
      message: `Profile '${folderName}' deleted`,
    });
  } catch (error) {
    console.error("[profiles:delete] Error deleting profile:", error);
    res.status(500).json({ error: "Internal server error deleting profile" });
  }
});

// POST /api/v1/profiles/:folderName/tiktok-account - Quick sync of logged-in TikTok account details
profilesRouter.post("/:folderName/tiktok-account", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  const folderName = req.params.folderName?.trim();
  const { isLoggedIn, tiktokUid, displayId, nickname, avatarUrl } = req.body ?? {};

  if (isNaN(userId) || !folderName) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  try {
    const updatedAccount = {
      isLoggedIn: Boolean(isLoggedIn),
      tiktokUid: tiktokUid ? String(tiktokUid) : null,
      displayId: displayId ? String(displayId) : null,
      nickname: nickname ? String(nickname) : null,
      avatarUrl: avatarUrl ? String(avatarUrl) : null,
      lastSyncAt: new Date(),
    };

    const profile = await InstanceProfile.findOneAndUpdate(
      { userId, profileFolderName: folderName },
      { $set: { tiktokAccount: updatedAccount } },
      { new: true }
    );

    if (!profile) {
      res.status(404).json({ error: `Profile '${folderName}' not found` });
      return;
    }

    res.json({
      success: true,
      message: "TikTok account identity synced",
      tiktokAccount: profile.tiktokAccount,
    });
  } catch (error) {
    console.error("[profiles:syncTiktokAccount] Error:", error);
    res.status(500).json({ error: "Internal server error syncing TikTok account" });
  }
});

// POST /api/v1/profiles/sync - Batch sync profiles from client
profilesRouter.post("/sync", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { profiles } = req.body ?? {};
  if (!Array.isArray(profiles)) {
    res.status(400).json({ error: "profiles array is required" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    for (const item of profiles) {
      if (!item.profileFolderName || !item.name) continue;

      const folderClean = String(item.profileFolderName).trim();
      const updateData: Partial<IInstanceProfile> = {
        userRef: user._id,
        userId: user.userId,
        name: String(item.name).trim(),
        profileFolderName: folderClean,
        cdpPort: Number(item.cdpPort) || 9221,
        launchMode: item.launchMode === "Sandboxie" ? "Sandboxie" : "DirectProfile",
        proxyId: item.proxyId || null,
        streamerUsername: String(item.streamerUsername || "").trim(),
        customChromiumFlags: String(item.customChromiumFlags || ""),
      };

      if (item.clientProfileId) {
        updateData.clientProfileId = String(item.clientProfileId).trim();
      }

      if (item.tiktokAccount && typeof item.tiktokAccount === "object") {
        updateData.tiktokAccount = {
          isLoggedIn: Boolean(item.tiktokAccount.isLoggedIn),
          tiktokUid: item.tiktokAccount.tiktokUid ? String(item.tiktokAccount.tiktokUid) : null,
          displayId: item.tiktokAccount.displayId ? String(item.tiktokAccount.displayId) : null,
          nickname: item.tiktokAccount.nickname ? String(item.tiktokAccount.nickname) : null,
          avatarUrl: item.tiktokAccount.avatarUrl ? String(item.tiktokAccount.avatarUrl) : null,
          lastSyncAt: new Date(),
        };
      }

      if (Array.isArray(item.rules)) {
        updateData.rules = item.rules;
      }

      await InstanceProfile.findOneAndUpdate(
        { userId, profileFolderName: folderClean },
        { $set: updateData },
        { upsert: true, setDefaultsOnInsert: true }
      );
    }

    const allProfiles = await InstanceProfile.find({ userId }).sort({ profileFolderName: 1 }).lean();
    res.json({
      success: true,
      message: "Batch sync completed",
      count: allProfiles.length,
      profiles: allProfiles,
    });
  } catch (error) {
    console.error("[profiles:batchSync] Error:", error);
    res.status(500).json({ error: "Internal server error during batch sync" });
  }
});
