import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export interface IActiveLease {
  _id?: Types.ObjectId;
  leaseId: string;
  userId: number;
  profileFolderName: string;
  hwid: string;
  ipAddress?: string;
  expiresAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ActiveLeaseDocument = HydratedDocument<IActiveLease>;

const ActiveLeaseSchema = new Schema<IActiveLease>(
  {
    leaseId: { type: String, required: true, unique: true, index: true },
    userId: { type: Number, required: true, index: true },
    profileFolderName: { type: String, required: true },
    hwid: { type: String, required: true },
    ipAddress: { type: String, default: "" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

ActiveLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ActiveLeaseSchema.index({ userId: 1, profileFolderName: 1 }, { unique: true });

export const ActiveLease = mongoose.model<IActiveLease>("ActiveLease", ActiveLeaseSchema);
