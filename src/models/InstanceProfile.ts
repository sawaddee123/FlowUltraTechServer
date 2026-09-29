import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export interface IRuleItem {
  id: string;
  name: string;
  isEnabled: boolean;
  triggerType: "ChatKeyword" | "GiftMinDiamonds" | "MemberEnter" | string;
  pattern?: string;
  isRegex?: boolean;
  minDiamonds?: number;
  responseTemplate: string;
  cooldownSeconds: number;
}

export interface IInstanceProfile {
  _id?: Types.ObjectId;
  userRef?: Types.ObjectId;
  userId: number;
  clientProfileId?: string;
  name: string;
  profileFolderName: string;
  cdpPort: number;
  launchMode: "DirectProfile" | "Sandboxie";
  proxyId?: Types.ObjectId | string | null;
  streamerUsername?: string;
  customChromiumFlags?: string;
  tiktokAccount: {
    isLoggedIn: boolean;
    tiktokUid?: string | null;
    displayId?: string | null;
    nickname?: string | null;
    avatarUrl?: string | null;
    lastSyncAt?: Date | null;
  };
  rules: IRuleItem[];
  createdAt?: Date;
  updatedAt?: Date;
}

export type InstanceProfileDocument = HydratedDocument<IInstanceProfile>;

const InstanceProfileSchema = new Schema<IInstanceProfile>(
  {
    userRef: { type: Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: Number, required: true, index: true },
    clientProfileId: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    profileFolderName: { type: String, required: true, trim: true },
    cdpPort: { type: Number, required: true },
    launchMode: { type: String, enum: ["DirectProfile", "Sandboxie"], default: "DirectProfile" },
    proxyId: { type: Schema.Types.Mixed, default: null },
    streamerUsername: { type: String, default: "" },
    customChromiumFlags: { type: String, default: "" },
    tiktokAccount: {
      isLoggedIn: { type: Boolean, default: false },
      tiktokUid: { type: String, default: null },
      displayId: { type: String, default: null },
      nickname: { type: String, default: null },
      avatarUrl: { type: String, default: null },
      lastSyncAt: { type: Date, default: null },
    },
    rules: [
      {
        id: { type: String, required: true },
        name: { type: String, required: true },
        isEnabled: { type: Boolean, default: true },
        triggerType: { type: String, required: true },
        pattern: { type: String, default: "" },
        isRegex: { type: Boolean, default: false },
        minDiamonds: { type: Number, default: 1 },
        responseTemplate: { type: String, required: true },
        cooldownSeconds: { type: Number, default: 3 },
      },
    ],
  },
  { timestamps: true }
);

InstanceProfileSchema.index({ userId: 1, profileFolderName: 1 }, { unique: true });

export const InstanceProfile = mongoose.model<IInstanceProfile>("InstanceProfile", InstanceProfileSchema);
