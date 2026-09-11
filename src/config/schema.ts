import { z } from "zod";
import { ENHANCER_IDS } from "../types/index.js";

const outputFormatSchema = z.enum(["txt", "srt"]);

export const enhanceOptionsSchema = z.object({
  /** Add ffmpeg adeclick at the head of the chain */
  declick: z.boolean().default(false),
  /** Run mains-hum analysis and notch detected fundamentals/harmonics */
  humNotch: z.boolean().default(true),
  /** Detect and notch sustained feedback howls (off by default: risky for music) */
  howlNotch: z.boolean().default(false),
  /** DeepFilterNet attenuation limit in dB (protects speech in mixed content) */
  dfnAttenLimDb: z.number().int().min(0).max(40).optional(),
  /** loudnorm integrated loudness target (master profile) */
  loudnessTargetLufs: z.number().min(-30).max(-5).default(-16),
});

const enhancerSchemaValues = ["none", ...ENHANCER_IDS] as const;

export const configSchema = z.object({
  inputFolder: z.string().default("./data/input"),
  outputFolder: z.string().default("./data/output"),
  tempFolder: z.string().default("./data/temp"),
  backend: z.string().default("whisper-local"),
  whisperModel: z.string().default("large-v2"),
  device: z.enum(["auto", "cuda", "cpu"]).default("auto"),
  maxDurationSeconds: z.number().int().positive().default(1200),
  keepIntermediateFiles: z.boolean().default(false),
  outputFormats: z.array(outputFormatSchema).min(1).default(["txt", "srt"]),
  // Audio enhancement. Engine ids come from ENHANCER_IDS — the single source
  // of truth shared with the registry and the CLI.
  enhancer: z.enum(enhancerSchemaValues).default("none"),
  enhanceProfile: z.enum(["asr", "master"]).default("asr"),
  // .default({}) relies on zod v3 parsing default values through the inner
  // schema (so inner defaults apply for parse({}) callers).
  enhanceOptions: enhanceOptionsSchema.default({}),
  /** Consent for engines that upload audio off-machine (currently: unise) */
  allowUpload: z.boolean().default(false),

  // Backend-specific config
  openaiApiKey: z.string().optional(),
  localWhisperCommand: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;
export type EnhanceOptions = z.infer<typeof enhanceOptionsSchema>;

export const defaultConfig: Config = configSchema.parse({});
