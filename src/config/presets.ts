export type QualityPreset = "fast" | "balanced" | "accurate";

export const QUALITY_PRESETS = ["fast", "balanced", "accurate"] as const;

const LOCAL_PRESET_MODELS: Record<QualityPreset, string> = {
  fast: "base",
  balanced: "small",
  accurate: "large-v2",
};

export function isQualityPreset(value: string): value is QualityPreset {
  return (QUALITY_PRESETS as readonly string[]).includes(value);
}

export function modelForPreset(
  preset: QualityPreset,
  backendName: string,
  backendDefaultModel: string,
): string {
  if (backendName === "whisper-local") {
    return LOCAL_PRESET_MODELS[preset];
  }

  return backendDefaultModel;
}