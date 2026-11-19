export type QualityPreset = "fast" | "balanced" | "accurate";

export const QUALITY_PRESETS = ["fast", "balanced", "accurate"] as const;

const LOCAL_PRESET_MODELS: Record<QualityPreset, string> = {
  fast: "base",
  balanced: "small",
  accurate: "large-v3",
};

/** Backends that consume Whisper model names, so presets apply to all three. */
export const WHISPER_MODEL_BACKENDS = ["whisper-local", "faster-whisper", "whisper-cpp"] as const;

export function isQualityPreset(value: string): value is QualityPreset {
  return (QUALITY_PRESETS as readonly string[]).includes(value);
}

export function modelForPreset(
  preset: QualityPreset,
  backendName: string,
  backendDefaultModel: string,
): string {
  if ((WHISPER_MODEL_BACKENDS as readonly string[]).includes(backendName)) {
    return LOCAL_PRESET_MODELS[preset];
  }

  return backendDefaultModel;
}