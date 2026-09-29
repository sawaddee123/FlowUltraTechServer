import mongoose, { Schema, type Types, type HydratedDocument } from "mongoose";

export interface IProxy {
  _id?: Types.ObjectId;
  userRef?: Types.ObjectId;
  userId: number;
  clientProxyId?: string;
  name: string;
  host: string;
  port: number;
  protocol: "socks5" | "http";
  username?: string;
  password?: string;
  proxifierId: number;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type ProxyDocument = HydratedDocument<IProxy>;

const ProxySchema = new Schema<IProxy>(
  {
    userRef: { type: Schema.Types.ObjectId, ref: "User", index: true },
    userId: { type: Number, required: true, index: true },
    clientProxyId: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    host: { type: String, required: true, trim: true },
    port: { type: Number, required: true },
    protocol: { type: String, enum: ["socks5", "http"], default: "socks5" },
    username: { type: String, default: "" },
    password: { type: String, default: "" },
    proxifierId: { type: Number, required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ProxySchema.index({ userId: 1, proxifierId: 1 });
ProxySchema.index({ userId: 1, clientProxyId: 1 });

export const Proxy = mongoose.model<IProxy>("Proxy", ProxySchema);
