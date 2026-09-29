import mongoose from "mongoose";
import { env } from "./env.js";

const DEFAULT_MONGODB_URI = "mongodb://127.0.0.1:27017/flowultratech";

export const getMongoUri = (): string => {
  return env.MONGODB_URI || process.env.MONGODB_URI || DEFAULT_MONGODB_URI;
};

export const connectDb = async (): Promise<typeof mongoose> => {
  const uri = getMongoUri();

  mongoose.connection.on("connected", () => {
    console.log(`[MongoDB] Connected successfully to ${uri}`);
  });

  mongoose.connection.on("error", (err) => {
    console.error("[MongoDB] Connection error:", err);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[MongoDB] Disconnected from database");
  });

  try {
    await mongoose.connect(uri);
    return mongoose;
  } catch (error) {
    console.error(`[MongoDB] Failed to connect to ${uri}:`, error);
    throw error;
  }
};

export const disconnectDb = async (): Promise<void> => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("[MongoDB] Disconnected successfully");
  }
};
