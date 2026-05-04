// --- YOLO mode ---

export type YoloMode = "off" | "writes" | "roam" | "yolo";

export const YOLO_MODES: YoloMode[] = ["off", "writes", "roam", "yolo"];

export const YOLO_LABELS: Record<YoloMode, string> = {
  off: "nolo",
  writes: "writes",
  roam: "roam",
  yolo: "yolo",
};

/** Custom session entry type for persisting YOLO mode across reloads */
export const YOLO_ENTRY_TYPE = "nolo:yolo-mode";

// --- Config shape ---

export interface NoloConfig {
  safePrefixes: string[];
  dangerousPatterns: string[];
  segmentDangerousPatterns: string[];
  protectedPaths: string[];
}
