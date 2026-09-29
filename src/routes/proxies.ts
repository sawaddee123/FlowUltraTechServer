import express, { type Router, type Request, type Response } from "express";
import { authenticateToken } from "../middlewares/auth.js";
import { Proxy, type IProxy } from "../models/Proxy.js";
import { User, type UserDocument } from "../models/User.js";

export const proxiesRouter: Router = express.Router();

proxiesRouter.use(authenticateToken);

const getUserId = (req: Request): number => {
  return typeof req.userId === "number" ? req.userId : Number(req.userId);
};

// GET /api/v1/proxies - List all proxies for the user
proxiesRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const proxies = await Proxy.find({ userId }).sort({ proxifierId: 1 }).lean();
    res.json({
      success: true,
      count: proxies.length,
      proxies,
    });
  } catch (error) {
    console.error("[proxies:list] Error fetching proxies:", error);
    res.status(500).json({ error: "Internal server error fetching proxies" });
  }
});

// POST /api/v1/proxies - Create or Upsert a single proxy
proxiesRouter.post("/", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    clientProxyId,
    name,
    host,
    port,
    protocol = "socks5",
    username = "",
    password = "",
    proxifierId,
    isActive = true,
  } = req.body ?? {};

  if (!host || !port) {
    res.status(400).json({ error: "host and port are required" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const assignedProxifierId = Number(proxifierId) || 100;
    const updateData: Partial<IProxy> = {
      userRef: user._id,
      userId: user.userId,
      name: String(name || `Proxy #${assignedProxifierId}`).trim(),
      host: String(host).trim(),
      port: Number(port),
      protocol: protocol === "http" ? "http" : "socks5",
      username: String(username || ""),
      password: String(password || ""),
      proxifierId: assignedProxifierId,
      isActive: Boolean(isActive),
    };

    if (clientProxyId) {
      updateData.clientProxyId = String(clientProxyId).trim();
    }

    const query = clientProxyId
      ? { userId, clientProxyId: String(clientProxyId).trim() }
      : { userId, proxifierId: assignedProxifierId };

    const proxy = await Proxy.findOneAndUpdate(
      query,
      { $set: updateData },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      success: true,
      message: "Proxy saved successfully",
      proxy,
    });
  } catch (error) {
    console.error("[proxies:save] Error saving proxy:", error);
    res.status(500).json({ error: "Internal server error saving proxy" });
  }
});

// DELETE /api/v1/proxies/:identifier - Delete a proxy by clientProxyId, proxifierId or _id
proxiesRouter.delete("/:identifier", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  const identifier = req.params.identifier?.trim();

  if (isNaN(userId) || !identifier) {
    res.status(400).json({ error: "Invalid parameters" });
    return;
  }

  try {
    const isNum = !isNaN(Number(identifier));
    const query: any = { userId };
    if (isNum) {
      query.proxifierId = Number(identifier);
    } else {
      query.$or = [{ clientProxyId: identifier }, { _id: identifier }];
    }

    const result = await Proxy.findOneAndDelete(query);
    if (!result) {
      res.status(404).json({ error: "Proxy not found" });
      return;
    }

    res.json({
      success: true,
      message: "Proxy deleted successfully",
    });
  } catch (error) {
    console.error("[proxies:delete] Error deleting proxy:", error);
    res.status(500).json({ error: "Internal server error deleting proxy" });
  }
});

// POST /api/v1/proxies/sync - Batch sync proxies from client
proxiesRouter.post("/sync", async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (isNaN(userId)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const { proxies } = req.body ?? {};
  if (!Array.isArray(proxies)) {
    res.status(400).json({ error: "proxies array is required" });
    return;
  }

  try {
    const user = (await User.findOne({ userId })) as UserDocument | null;
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Replace or Upsert all
    for (const item of proxies) {
      if (!item.host || !item.port) continue;

      const pId = Number(item.proxifierId) || 100;
      const updateData: Partial<IProxy> = {
        userRef: user._id,
        userId: user.userId,
        name: String(item.name || `Proxy #${pId}`).trim(),
        host: String(item.host).trim(),
        port: Number(item.port),
        protocol: item.protocol === "http" ? "http" : "socks5",
        username: String(item.username || ""),
        password: String(item.password || ""),
        proxifierId: pId,
        isActive: item.isActive !== false,
      };

      if (item.clientProxyId) {
        updateData.clientProxyId = String(item.clientProxyId).trim();
      }

      const query = item.clientProxyId
        ? { userId, clientProxyId: String(item.clientProxyId).trim() }
        : { userId, proxifierId: pId };

      await Proxy.findOneAndUpdate(query, { $set: updateData }, { upsert: true, setDefaultsOnInsert: true });
    }

    const allProxies = await Proxy.find({ userId }).sort({ proxifierId: 1 }).lean();
    res.json({
      success: true,
      message: "Proxy batch sync completed",
      count: allProxies.length,
      proxies: allProxies,
    });
  } catch (error) {
    console.error("[proxies:batchSync] Error:", error);
    res.status(500).json({ error: "Internal server error during proxy batch sync" });
  }
});
