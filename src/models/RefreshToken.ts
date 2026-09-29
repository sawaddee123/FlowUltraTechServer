import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export interface IRefreshToken {
  _id?: Types.ObjectId;
  userRef?: Types.ObjectId;
  userId: number;
  tokenHash: string;
  device: {
    hwid: string;
    deviceName: string;
    ipAddress: string;
    appVersion: string;
  };
  expiresAt: Date;
  createdAt?: Date;
}

export type RefreshTokenDocument = HydratedDocument<IRefreshToken>;

const RefreshTokenSchema = new Schema<IRefreshToken>(
  {
    userRef: { type: Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: Number, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    device: {
      hwid: { type: String, required: true },
      deviceName: { type: String, default: "Unknown Device" },
      ipAddress: { type: String, default: "127.0.0.1" },
      appVersion: { type: String, default: "1.0.0" },
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshTokenSchema.index({ userId: 1, "device.hwid": 1 });

export const RefreshToken = mongoose.model<IRefreshToken>("RefreshToken", RefreshTokenSchema);
