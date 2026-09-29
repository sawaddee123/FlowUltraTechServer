import mongoose, { Schema, type Document, type Model } from "mongoose";

export type AuditAction =
  | "USER_CREATE"
  | "USER_UPDATE"
  | "USER_DELETE"
  | "USER_GRACE_PERIOD"
  | "DEVICE_RESET"
  | "LEASE_RELEASE"
  | "CAPTCHA_SOLVE"
  | "AUDIT_REVERT"
  | "SECURITY_INCIDENT"
  | "APP_RELEASE";

export type AuditCategory = "user" | "lease" | "captcha" | "security" | "system";

export interface AuditActor {
  userId: number;
  username: string;
  role: string;
  ipAddress?: string;
}

export interface AuditLogDocument extends Document {
  logId: string;
  timestamp: Date;
  actor: AuditActor;
  action: AuditAction;
  category: AuditCategory;
  targetId?: string;
  targetType?: string;
  summary: string;
  changes?: {
    before?: any;
    after?: any;
  };
  isReversible: boolean;
  isReverted: boolean;
  revertedAt?: Date;
  revertedBy?: {
    userId: number;
    username: string;
  };
  revertLogId?: string;
  metadata?: any;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    logId: { type: String, required: true, unique: true, index: true },
    timestamp: { type: Date, default: Date.now, index: true },
    actor: {
      userId: { type: Number, required: true },
      username: { type: String, required: true },
      role: { type: String, required: true },
      ipAddress: { type: String, default: "127.0.0.1" },
    },
    action: {
      type: String,
      required: true,
      enum: [
        "USER_CREATE",
        "USER_UPDATE",
        "USER_DELETE",
        "USER_GRACE_PERIOD",
        "DEVICE_RESET",
        "LEASE_RELEASE",
        "CAPTCHA_SOLVE",
        "AUDIT_REVERT",
        "SECURITY_INCIDENT",
        "APP_RELEASE",
      ],
      index: true,
    },
    category: {
      type: String,
      required: true,
      enum: ["user", "lease", "captcha", "security", "system"],
      index: true,
    },
    targetId: { type: String, index: true },
    targetType: { type: String },
    summary: { type: String, required: true },
    changes: {
      before: { type: Schema.Types.Mixed, default: null },
      after: { type: Schema.Types.Mixed, default: null },
    },
    isReversible: { type: Boolean, default: false, index: true },
    isReverted: { type: Boolean, default: false, index: true },
    revertedAt: { type: Date },
    revertedBy: {
      userId: { type: Number },
      username: { type: String },
    },
    revertLogId: { type: String },
    metadata: { type: Schema.Types.Mixed },
  },
  {
    timestamps: true,
  }
);

export const AuditLog: Model<AuditLogDocument> =
  mongoose.models.AuditLog || mongoose.model<AuditLogDocument>("AuditLog", auditLogSchema, "audit_logs");
