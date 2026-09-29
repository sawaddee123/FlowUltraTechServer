import path from "node:path";
import * as ort from "onnxruntime-node";

const MODELS_DIR = path.join(process.cwd(), "models");

const sessions = new Map<string, Promise<ort.InferenceSession>>();

export const getSession = (modelFile: string): Promise<ort.InferenceSession> => {
  const cached = sessions.get(modelFile);
  if (cached) return cached;

  const fullPath = path.join(MODELS_DIR, modelFile);
  const promise = ort.InferenceSession.create(fullPath, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  }).then((session) => {
    console.log(`[onnx] loaded ${modelFile}`);
    return session;
  });
  sessions.set(modelFile, promise);
  return promise;
};

export { ort };
