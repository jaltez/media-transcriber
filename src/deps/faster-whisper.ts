import { execa } from "execa";
import type { DependencyStatus } from "../types/index.js";
import { checkCommand } from "./checker.js";
import { PROBE_CACHE_KEYS, withProbeCache } from "./cache.js";
import { findPythonCommand } from "./whisper.js";

export type FasterWhisperSource = "python" | "uv";

export interface FasterWhisperCommandSpec {
  command: string;
  /**
   * Arguments up to and including the "-c" transcription script. Backends
   * append their run arguments after it (sys.argv[1:] inside the script).
   */
  args: string[];
  display: string;
  source: FasterWhisperSource;
}

export interface FasterWhisperStatus extends DependencyStatus {
  source?: FasterWhisperSource;
  commandSpec?: FasterWhisperCommandSpec;
}

export const FASTER_WHISPER_INSTALL_HINT =
  "Run 'media-transcriber setup faster-whisper', or install faster-whisper with uv, pipx, or pip.";

/**
 * Transcription entry point. Receives its run arguments via sys.argv[1:]:
 *   --model <name> --device auto|cuda|cpu --output <json path> <input audio>
 * Decodes any ffmpeg-readable input to 16 kHz mono WAV, runs CTranslate2
 * inference with VAD and beam search, and writes a JSON payload to --output
 * (model loading logs go to stderr, so results never travel via stdout).
 */
export const FASTER_WHISPER_TRANSCRIBE_SCRIPT = `
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

def to_mono_wav(audio_path):
    # Always transcode: the samples are fed to CTranslate2 directly, so the
    # format must be 16 kHz mono 16-bit regardless of the input container.
    handle, target = tempfile.mkstemp(prefix="faster_whisper_input_", suffix=".wav")
    os.close(handle)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", audio_path, "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", target],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return target

def read_audio(path):
    # Passing a float32 array keeps faster-whisper's PyAV decoder out of the
    # path: PyAV >= 19 dropped the metadata_errors argument the decoder still
    # passes, which fails on every file.
    import numpy
    with wave.open(path, "rb") as source:
        frames = source.readframes(source.getnframes())
    return numpy.frombuffer(frames, dtype=numpy.int16).astype(numpy.float32) / 32768.0

def resolve_device(requested):
    if requested in ("cuda", "cpu"):
        return requested
    try:
        import ctranslate2
        # A visible CUDA device is not enough: the CTranslate2 CUDA backend
        # also needs cuBLAS, which wheels do not bundle. Ask the backend to
        # load so a GPU-less environment falls back to CPU instead of failing
        # mid-transcription.
        if ctranslate2.get_cuda_device_count() > 0:
            ctranslate2.get_supported_compute_types("cuda")
            return "cuda"
    except Exception:
        pass
    return "cpu"

def transcribe(model_name, device, audio):
    from faster_whisper import WhisperModel
    compute_type = "float16" if device == "cuda" else "int8"
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments_iter, _info = model.transcribe(audio, vad_filter=True, beam_size=5)
    return [
        {"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip()}
        for segment in segments_iter
        if segment.text.strip()
    ]

def main():
    model_name, requested_device, output_path, audio_path = parse_args(sys.argv[1:])
    if not model_name:
        fail("Missing --model")

    try:
        from faster_whisper import WhisperModel
    except ModuleNotFoundError as error:
        fail("Missing Python dependency: " + str(error) + ". Run 'media-transcriber setup faster-whisper'.")

    device = resolve_device(requested_device)
    wav_path = to_mono_wav(audio_path)

    try:
        audio = read_audio(wav_path)
        try:
            segments = transcribe(model_name, device, audio)
        except Exception:
            if requested_device != "auto" or device != "cuda":
                raise
            # Late CUDA failures (driver/library mismatch) still honor "auto".
            device = "cpu"
            segments = transcribe(model_name, device, audio)
    finally:
        if os.path.exists(wav_path):
            os.remove(wav_path)

    text = " ".join(segment["text"] for segment in segments).strip()
    payload = {"text": text, "segments": segments, "model": model_name, "device": device}
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

const FASTER_WHISPER_PROBE =
  'import importlib.util, sys; ' +
  "sys.exit(0 if importlib.util.find_spec('faster_whisper') is not None else 1)";

async function findPythonFasterWhisper(): Promise<FasterWhisperCommandSpec | null> {
  const python = await findPythonCommand();
  if (!python) return null;

  try {
    const result = await execa(
      python.command,
      [...python.args, "-c", FASTER_WHISPER_PROBE],
      { timeout: 15_000, reject: false },
    );
    if (result.exitCode !== 0) return null;
  } catch {
    return null;
  }

  return {
    command: python.command,
    args: [...python.args, "-c", FASTER_WHISPER_TRANSCRIBE_SCRIPT],
    display: `${python.display} (faster-whisper in active Python)`,
    source: "python",
  };
}

async function findUvFasterWhisper(): Promise<FasterWhisperCommandSpec | null> {
  const uv = await checkCommand("uv");
  if (!uv.available) return null;

  return {
    command: "uv",
    args: [
      "run", "--no-project",
      "--with", "faster-whisper",
      "python", "-c", FASTER_WHISPER_TRANSCRIBE_SCRIPT,
    ],
    display: "uv run --no-project --with faster-whisper python",
    source: "uv",
  };
}

async function getFasterWhisperVersion(
  spec: FasterWhisperCommandSpec,
): Promise<string | undefined> {
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
        'import importlib.metadata; print(importlib.metadata.version("faster_whisper"))',
      ],
      { timeout: 10_000, reject: false },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return `faster-whisper v${result.stdout.trim()}`;
    }
  } catch {
    // Version is non-critical.
  }

  return undefined;
}

/**
 * Discover a usable CTranslate2 runtime for the Faster-Whisper backend. Order:
 * active Python (faster_whisper importable) -> uv (ephemeral managed
 * environment, cached after the first build).
 */
export async function discoverFasterWhisper(): Promise<FasterWhisperStatus> {
  return withProbeCache(
    PROBE_CACHE_KEYS.fasterWhisper,
    (status) => status.available === true,
    () => discoverFasterWhisperFresh(),
  );
}

async function discoverFasterWhisperFresh(): Promise<FasterWhisperStatus> {
  const candidates: Array<Promise<FasterWhisperCommandSpec | null>> = [
    findPythonFasterWhisper(),
    findUvFasterWhisper(),
  ];
  for (const candidate of await Promise.all(candidates)) {
    if (!candidate) continue;
    return {
      available: true,
      name: "faster-whisper",
      version: await getFasterWhisperVersion(candidate),
      source: candidate.source,
      command: candidate.display,
      commandSpec: candidate,
    };
  }

  return {
    available: false,
    name: "faster-whisper",
    error: "No usable faster-whisper installation found",
    installHint: FASTER_WHISPER_INSTALL_HINT,
  };
}
