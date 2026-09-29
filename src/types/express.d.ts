import type { ActiveLeaseDocument } from "../models/ActiveLease.js";
import type { UserDocument } from "../models/User.js";

declare global {
  namespace Express {
    interface Request {
      userId?: number | string;
      user?: UserDocument;
      activeLease?: any;
      jti?: string;
      sendBody?: unknown;
    }
  }
}

export {};
