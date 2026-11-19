import { execa } from "execa";
import type { DependencyStatus } from "../types/index.js";
import { checkCommand } from "./checker.js";
import { PROBE_CACHE_KEYS, withProbeCache } from "./cache.js";
import { findPythonCommand } from "./whisper.js";

export type SpeechLmSource = "python" | "uv";

export interface SpeechLmCommandSpec {
  command: string;
  /**
   * Arguments up to and including the "-c" transcription script. Backends
   * append their run arguments after it (sys.argv[1:] inside the script).
   */
  args: string[];
  display: string;
  source: SpeechLmSource;
}

export interface SpeechLmStatus extends DependencyStatus {
  source?: SpeechLmSource;
  commandSpec?: SpeechLmCommandSpec;
}

/**
 * Transcription entry point shared by the speech-LM backends (Granite,
 * Voxtral). Receives its run arguments via sys.argv[1:]:
 *   --model <name> --device auto|cuda|cpu --output <json path> <input audio>
 * Both families emit text only (no word timestamps), so the audio is chunked
 * to bound VRAM and generate() cost, and each chunk becomes one cue.
 */
export const SPEECH_LM_TRANSCRIBE_SCRIPT = `
import json, os, subprocess, sys, tempfile, wave

CHUNK_SECONDS = 120

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

def cuda_available():
    # torch.cuda.is_available() can abort the interpreter on a broken driver
    # (seen on WSL2), so ask a child process: a crash means "no GPU".
    try:
        probe = subprocess.run(
            [sys.executable, "-c", "import torch, sys; sys.exit(0 if torch.cuda.is_available() else 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120,
        )
        return probe.returncode == 0
    except Exception:
        return False

def resolve_device(requested):
    if requested in ("cuda", "cpu"):
        return requested
    return "cuda" if cuda_available() else "cpu"

def cpu_dtype(torch):
    # bfloat16 is ~2x smaller and much faster where the CPU has native bf16
    # kernels; elsewhere torch emulates it, so stay on float32.
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as source:
            flags = source.read()
        if "avx512_bf16" in flags or "amx_bf16" in flags:
            return torch.bfloat16
    except Exception:
        pass
    return torch.float32

def load_waveform(path, torch):
    import numpy
    with wave.open(path, "rb") as source:
        frames = source.readframes(source.getnframes())
    samples = numpy.frombuffer(frames, dtype=numpy.int16).astype(numpy.float32) / 32768.0
    return torch.from_numpy(samples).unsqueeze(0)

def to_mono_wav(audio_path):
    # Always transcode: chunk boundaries and the models both assume 16 kHz
    # mono 16-bit input, whatever the source container was.
    handle, target = tempfile.mkstemp(prefix="speech_lm_input_", suffix=".wav")
    os.close(handle)
    subprocess.run(
        ["ffmpeg", "-nostdin", "-y", "-i", audio_path, "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", target],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    return target

def chunk_wav(path, chunk_seconds=CHUNK_SECONDS):
    chunks = []
    with wave.open(path, "rb") as source:
        rate = source.getframerate() or 16000
        width = source.getsampwidth() or 2
        channels = source.getnchannels() or 1
        frames_per_chunk = max(1, int(rate * chunk_seconds))
        offset = 0.0
        while True:
            data = source.readframes(frames_per_chunk)
            if not data:
                break
            frames = len(data) // max(1, width * channels)
            if frames == 0:
                break
            handle, target = tempfile.mkstemp(prefix="speech_lm_chunk_", suffix=".wav")
            os.close(handle)
            with wave.open(target, "wb") as sink:
                sink.setnchannels(channels)
                sink.setsampwidth(width)
                sink.setframerate(rate)
                sink.writeframes(data)
            duration = frames / float(rate)
            chunks.append({"path": target, "start": offset, "duration": duration})
            offset += duration
    return chunks

def load_granite(model_name, device, dtype):
    import torch
    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor
    model = AutoModelForSpeechSeq2Seq.from_pretrained(model_name, torch_dtype=dtype).to(device)
    model.eval()
    processor = AutoProcessor.from_pretrained(model_name)
    prompt = "<|audio|>transcribe the speech with proper punctuation and capitalization."
    chat = processor.tokenizer.apply_chat_template(
        [{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True,
    )
    return {"family": "granite", "torch": torch, "model": model, "processor": processor, "prompt": chat}

def load_voxtral(model_name, device, dtype):
    from transformers import AutoProcessor, VoxtralForConditionalGeneration
    model = VoxtralForConditionalGeneration.from_pretrained(model_name, torch_dtype=dtype).to(device)
    model.eval()
    processor = AutoProcessor.from_pretrained(model_name)
    return {"family": "voxtral", "model": model, "processor": processor, "model_name": model_name}

def transcribe_chunk(runtime, chunk_path, device, dtype, duration):
    if runtime["family"] == "granite":
        wav = load_waveform(chunk_path, runtime["torch"])
        inputs = runtime["processor"](runtime["prompt"], wav, device=device, return_tensors="pt").to(device)
    else:
        inputs = runtime["processor"].apply_transcription_request(
            audio=chunk_path, model_id=runtime["model_name"],
        ).to(device, dtype=dtype)

    prompt_tokens = inputs["input_ids"].shape[1]
    # ~8 tokens per second of audio (speech is ~150 wpm) with a small floor:
    # generous for the content, and it bounds a generation that never emits
    # EOS instead of burning the full 1024-token budget on every chunk.
    max_new_tokens = max(64, int(duration * 8))
    outputs = runtime["model"].generate(**inputs, max_new_tokens=max_new_tokens, do_sample=False)
    decoded = runtime["processor"].batch_decode(
        outputs[:, prompt_tokens:], skip_special_tokens=True,
    )
    return decoded[0].strip() if decoded else ""

def main():
    model_name, requested_device, output_path, audio_path = parse_args(sys.argv[1:])
    if not model_name:
        fail("Missing --model")

    family = "granite" if "granite" in model_name.lower() else "voxtral"

    # Resolve the device before importing torch: on a broken driver any CUDA
    # call aborts the process, so CPU runs must hide the GPU entirely.
    device = resolve_device(requested_device)
    if device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""

    try:
        import torch
        if family == "granite":
            from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor  # noqa: F401
        else:
            from transformers import AutoProcessor, VoxtralForConditionalGeneration  # noqa: F401
    except ModuleNotFoundError as error:
        fail("Missing Python dependency: " + str(error) + ". Run 'media-transcriber setup " + family + "'.")

    dtype = torch.bfloat16 if device == "cuda" else cpu_dtype(torch)
    wav_path = to_mono_wav(audio_path)
    chunks = chunk_wav(wav_path)

    segments = []
    try:
        runtime = load_granite(model_name, device, dtype) if family == "granite" else load_voxtral(model_name, device, dtype)
        for chunk in chunks:
            text = transcribe_chunk(runtime, chunk["path"], device, dtype, chunk["duration"])
            if not text:
                continue
            segments.append({
                "start": round(chunk["start"], 3),
                "end": round(chunk["start"] + chunk["duration"], 3),
                "text": text,
            })
    finally:
        for chunk in chunks:
            if os.path.exists(chunk["path"]):
                os.remove(chunk["path"])
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

const GRANITE_PROBE = `
import importlib.util, importlib.metadata, sys
try:
    ok = (
        importlib.util.find_spec('transformers') is not None
        and importlib.util.find_spec('torchaudio') is not None
        and tuple(int(x) for x in importlib.metadata.version('transformers').split('.')[:2]) >= (4, 52)
    )
except Exception:
    ok = False
sys.exit(0 if ok else 1)
`.trim();

const VOXTRAL_PROBE = `
import importlib.util, importlib.metadata, sys
try:
    ok = (
        importlib.util.find_spec('transformers') is not None
        and importlib.util.find_spec('mistral_common') is not None
        and tuple(int(x) for x in importlib.metadata.version('transformers').split('.')[:2]) >= (4, 54)
    )
except Exception:
    ok = False
sys.exit(0 if ok else 1)
`.trim();

export const GRANITE_UV_PACKAGES = ["transformers>=4.52.1", "torchaudio"];
export const VOXTRAL_UV_PACKAGES = ["transformers>=4.54", "mistral-common[audio]", "torchaudio", "soundfile"];

async function findPythonSpeechLm(
  backendName: string,
  probeExpr: string,
): Promise<SpeechLmCommandSpec | null> {
  const python = await findPythonCommand();
  if (!python) return null;

  try {
    const result = await execa(
      python.command,
      [...python.args, "-c", probeExpr],
      { timeout: 20_000, reject: false },
    );
    if (result.exitCode !== 0) return null;
  } catch {
    return null;
  }

  return {
    command: python.command,
    args: [...python.args, "-c", SPEECH_LM_TRANSCRIBE_SCRIPT],
    display: `${python.display} (${backendName} runtime in active Python)`,
    source: "python",
  };
}

async function findUvSpeechLm(
  uvPackages: readonly string[],
): Promise<SpeechLmCommandSpec | null> {
  const uv = await checkCommand("uv");
  if (!uv.available) return null;

  return {
    command: "uv",
    args: [
      "run", "--no-project",
      ...uvPackages.flatMap((pkg) => ["--with", pkg]),
      "python", "-c", SPEECH_LM_TRANSCRIBE_SCRIPT,
    ],
    display: `uv run --no-project ${uvPackages.map((pkg) => `--with "${pkg}"`).join(" ")} python`,
    source: "uv",
  };
}

async function getTransformersVersion(spec: SpeechLmCommandSpec): Promise<string | undefined> {
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
        'import importlib.metadata; print(importlib.metadata.version("transformers"))',
      ],
      { timeout: 10_000, reject: false },
    );
    if (result.exitCode === 0 && result.stdout.trim()) {
      return `transformers v${result.stdout.trim()}`;
    }
  } catch {
    // Version is non-critical.
  }

  return undefined;
}

/**
 * Discover a usable transformers speech-LM runtime. Order: active Python
 * (probe passes) -> uv (ephemeral managed environment, cached after the first
 * build). `cacheKey` keeps Granite and Voxtral probes independent.
 */
export async function discoverSpeechLm(
  backendName: string,
  cacheKey: string,
  probeExpr: string,
  uvPackages: readonly string[],
): Promise<SpeechLmStatus> {
  return withProbeCache(
    cacheKey,
    (status) => status.available === true,
    () => discoverSpeechLmFresh(backendName, probeExpr, uvPackages),
  );
}

async function discoverSpeechLmFresh(
  backendName: string,
  probeExpr: string,
  uvPackages: readonly string[],
): Promise<SpeechLmStatus> {
  const candidates: Array<Promise<SpeechLmCommandSpec | null>> = [
    findPythonSpeechLm(backendName, probeExpr),
    findUvSpeechLm(uvPackages),
  ];
  for (const candidate of await Promise.all(candidates)) {
    if (!candidate) continue;
    return {
      available: true,
      name: backendName,
      version: await getTransformersVersion(candidate),
      source: candidate.source,
      command: candidate.display,
      commandSpec: candidate,
    };
  }

  return {
    available: false,
    name: backendName,
    error: `No usable ${backendName} runtime found`,
    installHint: `Run 'media-transcriber setup ${backendName}', or install the packages with uv, pipx, or pip.`,
  };
}

export function discoverGranite(): Promise<SpeechLmStatus> {
  return discoverSpeechLm(
    "granite",
    PROBE_CACHE_KEYS.granite,
    GRANITE_PROBE,
    GRANITE_UV_PACKAGES,
  );
}

export function discoverVoxtral(): Promise<SpeechLmStatus> {
  return discoverSpeechLm(
    "voxtral",
    PROBE_CACHE_KEYS.voxtral,
    VOXTRAL_PROBE,
    VOXTRAL_UV_PACKAGES,
  );
}
