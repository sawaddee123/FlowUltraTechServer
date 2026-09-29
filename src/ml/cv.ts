// Mock CV module - not used in current implementation
// Kept for compatibility with existing code structure

export const getCv = async (): Promise<any> => {
  throw new Error('OpenCV not available in this version. Use sharp-based implementations instead.');
};

export type Cv = any;
