import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export interface IUser {
  _id?: Types.ObjectId;
  userId: number;
  username: string;
  email?: string;
  passwordHash: string;
  role: "superadmin" | "admin" | "user";
  isSystemRoot: boolean;
  status: "active" | "suspended" | "expired";
  expiredAt?: Date;
  license: {
    plan: string;
    expiredAt: Date;
    deviceLimit: number;
    maxTiktokAccounts: number;
  };
  captchaQuota: {
    dailyLimit: number;
    usedToday: number;
    lastResetDate: Date;
  };
  settings: {
    telegramBotToken?: string;
    telegramChatId?: string;
    autoSolveDelaySeconds: number;
    captchaSoundVolume: number;
    autoSaveCaptchaImage: boolean;
    rules?: any[];
  };
  createdAt?: Date;
  updatedAt?: Date;
}

export type UserDocument = HydratedDocument<IUser>;

export const CAPTCHAS_PER_TIKTOK_ACCOUNT = 200;

const UserSchema = new Schema<IUser>(
  {
    userId: { type: Number, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    email: { type: String, sparse: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["superadmin", "admin", "user"], default: "user" },
    isSystemRoot: { type: Boolean, default: false },
    status: { type: String, enum: ["active", "suspended", "expired"], default: "active", index: true },
    expiredAt: { type: Date, index: true },
    license: {
      plan: { type: String, default: "standard" },
      expiredAt: { type: Date, required: true, index: true },
      deviceLimit: { type: Number, default: 9999, min: 1 },
      maxTiktokAccounts: { type: Number, default: 1, min: 1 },
    },
    captchaQuota: {
      dailyLimit: { type: Number, default: CAPTCHAS_PER_TIKTOK_ACCOUNT },
      usedToday: { type: Number, default: 0 },
      lastResetDate: { type: Date, default: Date.now },
    },
    settings: {
      telegramBotToken: { type: String, default: "" },
      telegramChatId: { type: String, default: "" },
      autoSolveDelaySeconds: { type: Number, default: 5 },
      captchaSoundVolume: { type: Number, default: 80 },
      autoSaveCaptchaImage: { type: Boolean, default: true },
      rules: { type: Schema.Types.Mixed, default: [] },
    },
  },
  { timestamps: true }
);

UserSchema.pre("save", function () {
  if (this.license?.expiredAt) {
    this.expiredAt = this.license.expiredAt;
  } else if (this.expiredAt) {
    if (!this.license) {
      this.license = {
        plan: "standard",
        expiredAt: this.expiredAt,
        deviceLimit: 9999,
        maxTiktokAccounts: 1,
      };
    } else {
      this.license.expiredAt = this.expiredAt;
    }
  }

  if (!this.isSystemRoot && this.isNew && (!this.captchaQuota?.dailyLimit || this.captchaQuota.dailyLimit === CAPTCHAS_PER_TIKTOK_ACCOUNT)) {
    const accounts = Math.max(1, Number(this.license?.maxTiktokAccounts) || 1);
    if (!this.captchaQuota) {
      this.captchaQuota = {
        dailyLimit: accounts * CAPTCHAS_PER_TIKTOK_ACCOUNT,
        usedToday: 0,
        lastResetDate: new Date(),
      };
    } else {
      this.captchaQuota.dailyLimit = accounts * CAPTCHAS_PER_TIKTOK_ACCOUNT;
    }
  }
});

export const User = mongoose.model<IUser>("User", UserSchema);
