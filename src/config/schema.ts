import { z } from "zod";

const outputFormatSchema = z.enum(["txt", "srt"]);

export const configSchema = z.object({
  inputFolder: z.string().default("./data/input"),
  outputFolder: z.string().default("./data/output"),
  tempFolder: z.string().default("./data/temp"),
  backend: z.string().default("whisper-local"),
  whisperModel: z.string().default("large-v2"),
  device: z.enum(["auto", "cuda", "cpu"]).default("auto"),
  maxDurationSeconds: z.number().int().positive().default(1200),
  enableAudioEnhancement: z.boolean().default(false),
  keepIntermediateFiles: z.boolean().default(false),
  outputFormats: z.array(outputFormatSchema).min(1).default(["txt", "srt"]),

  // Backend-specific config
  openaiApiKey: z.string().optional(),
  localWhisperCommand: z.string().optional(),
});

export type Config = z.infer<typeof configSchema>;

export const defaultConfig: Config = configSchema.parse({});
