import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export type SecurityEventType =
  | "MULTIPLE_INSTANCE_ATTEMPT"
  | "HWID_MISMATCH"
  | "CONCURRENT_IP"
  | "EXPIRED_LEASE_ABUSE"
  | "RATE_LIMIT_EXCEEDED"
  | "ROOT_PROTECTION_TRIGGERED"
  | string;

export interface ISecurityEvent {
  _id?: Types.ObjectId;
  userId: number;
  eventType: SecurityEventType;
  details: Record<string, unknown>;
  ipAddress: string;
  hwid?: string;
  severity: "low" | "medium" | "high" | "critical";
  createdAt?: Date;
}

export type SecurityEventDocument = HydratedDocument<ISecurityEvent>;

const SecurityEventSchema = new Schema<ISecurityEvent>(
  {
    userId: { type: Number, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    details: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "127.0.0.1" },
    hwid: { type: String, default: "" },
    severity: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

SecurityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 5184000 });

export const SecurityEvent = mongoose.model<ISecurityEvent>("SecurityEvent", SecurityEventSchema);
