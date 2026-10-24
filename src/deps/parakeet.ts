import { execa } from "execa";
import type { DependencyStatus } from "../types/index.js";
import { checkCommand } from "./checker.js";
import { PROBE_CACHE_KEYS, withProbeCache } from "./cache.js";
import { findPythonCommand } from "./whisper.js";

export type ParakeetSource = "python" | "uv";

export interface ParakeetCommandSpec {
  command: string;
  /**
   * Arguments up to and including the "-c" transcription script. Backends
   * append their run arguments after it (sys.argv[1:] inside the script).
   */
  args: string[];
  display: string;
  source: ParakeetSource;
}

export interface ParakeetStatus extends DependencyStatus {
  source?: ParakeetSource;
  commandSpec?: ParakeetCommandSpec;
}

export const PARAKEET_INSTALL_HINT =
  "Run 'media-transcriber setup parakeet', install NVIDIA NeMo with " +
  'pip install "nemo-toolkit[asr]", or install uv (the environment is built automatically on first use).';

/**
 * Transcription entry point. Receives its run arguments via sys.argv[1:]:
 *   --model <name> --device auto|cuda|cpu --output <json path> <input audio>
 * Decodes any ffmpeg-readable input to 16 kHz mono WAV, loads the model,
 * transcribes with timestamps, and writes a JSON payload to --output
 * (stdout may carry NeMo logging, so results never travel via stdout).
 */
export const PARAKEET_TRANSCRIBE_SCRIPT = `
import json, os, subprocess, sys, tempfile, wave

def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)

def parse_args(argv):
    flags = ("--model", "--device", "--output")
    values = {}
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in flags:
            if i + 1 >= len(argv):
                fail("Missing value for " + arg)
            values[arg] = argv[i + 1]
            i += 2
        else:
            positional.append(arg)
            i += 1
    if len(positional) != 1:
        fail("Expected exactly one input audio file, got " + str(len(positional)))
    if not values.get("--output"):
        fail("Missing --output")
    return values.get("--model"), values.get("--device", "auto"), values["--output"], positional[0]

def resolve_device(torch, requested):
    if requested in ("cuda", "cpu"):
        return requested
    try:
        if torch.cuda.is_available():
            torch.zeros(1, device="cuda")
            return "cuda"
    except Exception:
        pass
    return "cpu"

def to_mono_wav(audio_path):
    if audio_path.lower().endswith(".wav"):
        return audio_path, False
    handle, target = tempfile.mkstemp(prefix="parakeet_input_", suffix=".wav")
    os.close(handle)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", audio_path, "-ac", "1", "-ar", "16000", target],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return target, True

def audio_duration(path):
    try:
        with wave.open(path, "rb") as source:
            rate = source.getframerate() or 1
            return source.getnframes() / float(rate)
    except Exception:
        return 0.0

def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0

def item_field(item, name, default=""):
    if isinstance(item, dict):
        return item.get(name, default)
    return getattr(item, name, default)

def collect_segments(timestamps):
    segments = []
    for item in timestamps or []:
        text = str(item_field(item, "segment") or item_field(item, "text") or "").strip()
        if not text:
            continue
        segments.append({
            "start": as_float(item_field(item, "start", 0)),
            "end": as_float(item_field(item, "end", 0)),
            "text": text,
        })
    return segments

def group_words(words, max_cue_seconds=7.0, max_gap_seconds=0.7):
    cues = []
    current = None
    for item in words or []:
        token = str(item_field(item, "word") or item_field(item, "text") or "").strip()
        if not token:
            continue
        start = as_float(item_field(item, "start", 0))
        end = as_float(item_field(item, "end", 0))
        if current is None or (start - current["end"]) > max_gap_seconds or (end - current["start"]) > max_cue_seconds:
            if current:
                cues.append(current)
            current = {"start": start, "end": end, "text": token}
        else:
            current["end"] = end
            current["text"] += " " + token
    if current:
        cues.append(current)
    return cues

def main():
    model_name, requested_device, output_path, audio_path = parse_args(sys.argv[1:])
    if not model_name:
        fail("Missing --model")

    try:
        import torch
        from nemo.collections.asr.models import ASRModel
    except ModuleNotFoundError as error:
        fail("Missing Python dependency: " + str(error) + ". Run 'media-transcriber setup parakeet'.")

    device = resolve_device(torch, requested_device)
    wav_path, temporary = to_mono_wav(audio_path)
    duration = audio_duration(wav_path)

    try:
        model = ASRModel.from_pretrained(model_name=model_name, map_location=device)
        model.eval()
        with torch.no_grad():
            results = model.transcribe([wav_path], timestamps=True, batch_size=1)
    finally:
        if temporary and os.path.exists(wav_path):
            os.remove(wav_path)

    if not results:
        fail("NeMo returned no transcription output")

    first = results[0]
    if isinstance(first, dict):
        text = str(first.get("text") or "")
        timestamps = first.get("timestamps") or {}
    else:
        text = str(getattr(first, "text", "") or "")
        timestamps = getattr(first, "timestamp", None) or {}

    segments = collect_segments(timestamps.get("segment"))
    if not segments:
        segments = group_words(timestamps.get("word"))
    if not segments and text.strip():
        segments = [{"start": 0.0, "end": round(duration, 3), "text": text.strip()}]

    payload = {"text": text.strip(), "segments": segments, "model": model_name, "device": device}
    with open(output_path, "w", encoding="utf-8") as target:
        json.dump(payload, target, ensure_ascii=False)

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        import traceback
        traceback.print_exc()
        sys.exit(1)
`.trim() + "\n";

const PARAKEET_PROBE = (
  'import importlib.util, importlib.metadata, sys; ' +
  "sys.exit(0 if importlib.util.find_spec('torch') is not None and importlib.metadata.version('nemo_toolkit') else 1)"
);

async function findPythonParakeet(): Promise<ParakeetCommandSpec | null> {
  const python = await findPythonCommand();
  if (!python) return null;

  try {
    const result = await execa(
      python.command,
      [...python.args, "-c", PARAKEET_PROBE],
      { timeout: 15_000, reject: false },
    );
    if (result.exitCode !== 0) return null;
  } catch {
    return null;
  }

  return {
    command: python.command,
    args: [...python.args, "-c", PARAKEET_TRANSCRIBE_SCRIPT],
    display: `${python.display} (nemo_toolkit in active Python)`,
    source: "python",
  };
}

async function findUvParakeet(): Promise<ParakeetCommandSpec | null> {
  const uv = await checkCommand("uv");
  if (!uv.available) return null;

  return {
    command: "uv",
    args: [
      "run", "--no-project",
      "--with", "nemo-toolkit[asr]",
      "python", "-c", PARAKEET_TRANSCRIBE_SCRIPT,
    ],
    display: 'uv run --no-project --with "nemo-toolkit[asr]" python',
    source: "uv",
  };
}

async function getNemoVersion(spec: ParakeetCommandSpec): Promise<string | undefined> {
  if (spec.source === "uv") {
    return "via uv (built on first use)";
  }

  const python = await findPythonCommand();
  if (!python) return undefined;

  try {
    const result = await execa(
      python.command,
      [
        ...python.args,
        "-c",
        'import importlib.metadata; print(importlib.metadata.version("nemo_toolkit"))',
      ],
      { timeout: 10_000, reject: false },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return `nemo-toolkit v${result.stdout.trim()}`;
    }
  } catch {
    // Version is non-critical.
  }

  return undefined;
}

/**
 * Discover a usable NVIDIA NeMo runtime for the Parakeet backends. Order:
 * active Python (nemo_toolkit + torch importable) -> uv (ephemeral managed
 * environment, cached after the first build).
 */
export async function discoverParakeet(): Promise<ParakeetStatus> {
  return withProbeCache(
    PROBE_CACHE_KEYS.parakeet,
    (status) => status.available === true,
    () => discoverParakeetFresh(),
  );
}

async function discoverParakeetFresh(): Promise<ParakeetStatus> {
  const candidates: Array<Promise<ParakeetCommandSpec | null>> = [
    findPythonParakeet(),
    findUvParakeet(),
  ];
  for (const candidate of await Promise.all(candidates)) {
    if (!candidate) continue;
    return {
      available: true,
      name: "parakeet",
      version: await getNemoVersion(candidate),
      source: candidate.source,
      command: candidate.display,
      commandSpec: candidate,
    };
  }

  return {
    available: false,
    name: "parakeet",
    error: "No usable NVIDIA NeMo installation found",
    installHint: PARAKEET_INSTALL_HINT,
  };
}
