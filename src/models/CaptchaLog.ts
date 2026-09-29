import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export type CaptchaStatus =
  | "CALCULATED"         // AI successfully computed coordinates; awaiting TikTok verification from client
  | "VERIFIED_SUCCESS"   // TikTok confirmed success (modal dismissed or success toast received)
  | "VERIFIED_FAILED"    // TikTok rejected the solve (modal remained or error toast received)
  | "SOLVE_FAILED"       // AI model could not detect coordinates ([0, 0] or invalid image)
  | "TIMEOUT";           // Client did not report verification feedback within timeout window

export interface ICaptchaVerification {
  verifiedAt?: Date;
  feedbackText?: string;
  attempts?: number;
  actualDurationSec?: number;
}

export interface ICaptchaLog {
  _id?: Types.ObjectId;
  captchaId: string;
  userRef?: Types.ObjectId;
  userId: number;
  username?: string;
  profileFolderName?: string;
  captchaType: "slide" | "symbol";
  imageFilename?: string;
  imageWithPositionFilename?: string;
  imageSize?: number;
  imageBase64?: string;
  imageWidth?: number;
  imageHeight?: number;
  displayWidth?: number;
  displayHeight?: number;
  appVersion?: string;
  aiVersion?: string;
  status: CaptchaStatus;
  result: {
    position?: number[];
    targetX?: number;
    symbolPositions?: number[][];
    rawPosition?: number[];
    rawSymbolPositions?: number[][];
    holeBox?: {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      width: number;
      height: number;
    };
    scaleX?: number;
    scaleY?: number;
    durationSec: number;
    success: boolean;
    errorMessage?: string | null;
  };
  verification?: ICaptchaVerification;
  clientIp: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export type CaptchaLogDocument = HydratedDocument<ICaptchaLog>;

const CaptchaLogSchema = new Schema<ICaptchaLog>(
  {
    captchaId: { type: String, required: true, unique: true, index: true },
    userRef: { type: Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: Number, required: true, index: true },
    username: { type: String, default: "unknown", index: true },
    profileFolderName: { type: String, default: "Acc01" },
    captchaType: { type: String, enum: ["slide", "symbol"], required: true },
    imageFilename: { type: String, default: undefined },
    imageWithPositionFilename: { type: String, default: undefined },
    imageSize: { type: Number, default: 0 },
    imageBase64: { type: String, default: undefined },
    imageWidth: { type: Number, default: undefined },
    imageHeight: { type: Number, default: undefined },
    displayWidth: { type: Number, default: undefined },
    displayHeight: { type: Number, default: undefined },
    appVersion: { type: String, default: undefined, index: true },
    aiVersion: { type: String, default: undefined },
    status: {
      type: String,
      enum: ["CALCULATED", "VERIFIED_SUCCESS", "VERIFIED_FAILED", "SOLVE_FAILED", "TIMEOUT"],
      default: "CALCULATED",
      index: true,
    },
    result: {
      position: { type: [Number], default: undefined },
      targetX: { type: Number, default: undefined },
      symbolPositions: { type: [[Number]], default: undefined },
      rawPosition: { type: [Number], default: undefined },
      rawSymbolPositions: { type: [[Number]], default: undefined },
      holeBox: { type: Object, default: undefined },
      scaleX: { type: Number, default: 1 },
      scaleY: { type: Number, default: 1 },
      durationSec: { type: Number, required: true },
      success: { type: Boolean, required: true },
      errorMessage: { type: String, default: null },
    },
    verification: {
      verifiedAt: { type: Date },
      feedbackText: { type: String },
      attempts: { type: Number, default: 1 },
      actualDurationSec: { type: Number },
    },
    clientIp: { type: String, default: "127.0.0.1" },
  },
  { timestamps: true }
);

CaptchaLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 });
CaptchaLogSchema.index({ userId: 1, createdAt: -1 });
CaptchaLogSchema.index({ status: 1, createdAt: -1 });

export const CaptchaLog = mongoose.model<ICaptchaLog>("CaptchaLog", CaptchaLogSchema);
