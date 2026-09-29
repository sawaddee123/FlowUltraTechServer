import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export interface IAppRelease {
  _id?: Types.ObjectId;
  version: string;
  minRequiredVersion: string;
  title?: string;
  description: string;
  fileName: string;
  fileSize: number;
  fileHash: string;
  downloadUrl: string;
  isMandatory: boolean;
  isLatest: boolean;
  publishedBy: {
    userId: number;
    username: string;
  };
  publishedAt: Date;
  downloadsCount: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type AppReleaseDocument = HydratedDocument<IAppRelease>;

const AppReleaseSchema = new Schema<IAppRelease>(
  {
    version: { type: String, required: true, trim: true, index: true },
    minRequiredVersion: { type: String, required: true, trim: true, default: "1.0.0" },
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    fileHash: { type: String, default: "" },
    downloadUrl: { type: String, required: true },
    isMandatory: { type: Boolean, default: false },
    isLatest: { type: Boolean, default: true, index: true },
    publishedBy: {
      userId: { type: Number, required: true },
      username: { type: String, required: true },
    },
    publishedAt: { type: Date, default: Date.now, index: true },
    downloadsCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const AppRelease = mongoose.model<IAppRelease>("AppRelease", AppReleaseSchema, "app_releases");
