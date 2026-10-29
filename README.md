# media-transcriber

Transcribe audio and video files to text and subtitles using pluggable AI backends, including local Whisper, NVIDIA Parakeet TDT, and the OpenAI Whisper API.

## Quick Start

```bash
# Run directly with npx (no install)
npx media-transcriber doctor

# Or install globally
npm install -g media-transcriber

# Update to the latest published version
media-transcriber update

# Check readiness for the default local backend
media-transcriber doctor

# If readiness fails, run guided setup
media-transcriber setup whisper-local

# Transcribe a single file
media-transcriber transcribe ./meeting.mp4

# Transcribe a folder
media-transcriber transcribe ./data/input ./data/output
```

## Requirements

- Node.js >= 18
- FFmpeg and ffprobe in PATH
  - Windows: `winget install ffmpeg` or `scoop install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

Backend requirements:
- `whisper-local`: A usable local Whisper installation. This can come from PATH, [uv](https://docs.astral.sh/uv/) tool installs, `pipx`, `pip`, or an active Python environment. Use `media-transcriber setup whisper-local` for guided setup.
- `parakeet`: NVIDIA NeMo with PyTorch. Found automatically when `nemo_toolkit` is installed in the active Python; otherwise a uv-managed environment is used (`uv run --with "nemo-toolkit[asr]"`, built automatically on first use). Use `media-transcriber setup parakeet` for guided setup. Model weights (~1.2 GB) download automatically on the first transcription. GPU (CUDA) recommended; falls back to CPU.
- `whisper-api`: OpenAI API key (`OPENAI_API_KEY` env var or `--api-key`)

`uv add openai-whisper` is only appropriate inside a Python project. For general CLI setup, prefer a tool-style install such as `uv tool install openai-whisper`, `pipx install openai-whisper`, or `python -m pip install -U openai-whisper`.

## Usage

### Transcribe

```bash
# Single file, output written next to the input file
media-transcriber transcribe ./recordings/interview.mp4

# Single file, explicit output folder
media-transcriber transcribe ./recordings/interview.mp4 ./transcripts

# Folder input
media-transcriber transcribe ./recordings ./transcripts

# Preset, model, and device
media-transcriber transcribe ./data/input ./data/output --preset accurate
media-transcriber transcribe ./data/input ./data/output -m medium -d cpu

# NVIDIA Parakeet TDT 0.6B v3 (local, GPU recommended)
media-transcriber transcribe ./data/input ./data/output -b parakeet
media-transcriber transcribe ./data/input ./data/output -b parakeet -d cuda

# Custom local Whisper command
media-transcriber transcribe ./meeting.mp4 --whisper-command "whisper"

# OpenAI API backend
media-transcriber transcribe ./data/input ./data/output -b whisper-api --api-key <key>

# Split long files before transcription
media-transcriber transcribe ./data/input ./data/output --split-threshold 900

# Enhance degraded audio before transcription (opt-in)
media-transcriber transcribe ./data/input ./data/output --enhance

# Enhance only, without transcribing (audition the result first)
media-transcriber enhance ./recording.wav ./out --report

# Keep temporary files in ./data/output/temp
media-transcriber transcribe ./data/input ./data/output --keep-temp

# Output only subtitles
media-transcriber transcribe ./data/input ./data/output -f srt

# JSON output for agents
media-transcriber transcribe ./data/input ./data/output --json
```

### Doctor

Check readiness for the default or selected transcription path. Enhancer availability is always shown (remote enhancers are only probed when selected or with `--all`, so a plain `doctor` never makes network requests); a selected enhancer is fatal when missing:

```bash
media-transcriber doctor
media-transcriber doctor --backend whisper-api
media-transcriber doctor --backend whisper-api --api-key <key>
media-transcriber doctor --whisper-command "whisper"
media-transcriber doctor --enhancer deepfilternet
media-transcriber doctor --all
media-transcriber doctor --json
media-transcriber doctor --no-cache
```

**Probe cache.** Discovering local Whisper or DeepFilterNet spawns a Python process that imports PyTorch, which costs seconds. Dependency probe results (ffmpeg, Whisper, DeepFilterNet, NeMo, CUDA availability) are therefore cached on disk and reused across commands: positive results for 1 hour, "not found" results for 10 minutes. This makes repeated `doctor` and `transcribe` runs start in a fraction of a second instead of re-probing every time. The cache is skipped automatically when `MEDIA_TRANSCRIBER_WHISPER_COMMAND` / `MEDIA_TRANSCRIBER_DFN_COMMAND` overrides are set, invalidated after a `setup` install, and self-heals if a cached tool stops launching. Bypass it for a single run with `--no-cache` (doctor) or `MEDIA_TRANSCRIBER_NO_CACHE=1` (any command). The cache lives in the platform cache directory (`~/.cache/media-transcriber` on Linux, `~/Library/Caches/media-transcriber` on macOS, `%LOCALAPPDATA%\media-transcriber\cache` on Windows) and can be redirected with `MEDIA_TRANSCRIBER_CACHE_DIR`.

### Setup

Run guided setup when readiness fails:

```bash
media-transcriber setup whisper-local
media-transcriber setup parakeet
media-transcriber setup whisper-api
media-transcriber setup deepfilternet
```

Setup can offer to run package managers after confirmation, validates the result, and can run an optional smoke test. It does not write Media Transcriber config files or store API keys.

For `deepfilternet`, setup installs the `deepfilternet` Python tool (uv/pipx/pip) with `torchaudio` pinned below 2.9 — deepfilternet 0.5.6 is incompatible with newer torchaudio releases. The DeepFilterNet 3 model weights download automatically on first use.

For `parakeet`, setup verifies a usable NVIDIA NeMo runtime (active Python or a uv-managed environment) and offers install paths: a uv-managed environment (nothing installed globally; the environment with NeMo + PyTorch is built automatically on first use) or `pip install "nemo-toolkit[asr]"` into the active Python.

## Update

`media-transcriber update` compares the installed version against the npm registry and updates in place:

```bash
media-transcriber update            # Check and install the latest version (asks first)
media-transcriber update --check    # Only report whether a new version exists
media-transcriber update --yes      # Skip the confirmation prompt
```

Behavior depends on how media-transcriber is running: a global npm install is updated via `npm install -g media-transcriber@latest`; an npx run prints guidance (npx caches don't self-update — use `npx media-transcriber@latest`); a git checkout prints the `git pull` workflow.

## Execution Options

All parameters are passed at execution time (stateless CLI).

| Field | Type | Default | Description |
| ---- | ---- | ---- | ---- |
| `input` | string | required | Input file or folder |
| `output` | string | optional for files, required for folders | Output folder |
| `backend` | string | `whisper-local` | Transcription backend: `whisper-local`, `parakeet`, `whisper-api` |
| `whisperModel` | string | backend default | Model name (e.g. `large-v3` for whisper-local, `parakeet-tdt-0.6b-v3` for parakeet, `whisper-1` for whisper-api) |
| `preset` | `fast`, `balanced`, or `accurate` | unset | Friendly quality preset (whisper-local maps to `base`, `small`, `large-v2`) |
| `device` | `auto`, `cuda`, or `cpu` | `auto` | Processing device policy |
| `enhancer` | `none`, `basic`, `deepfilternet`, or `unise` | `none` | Audio enhancement engine |
| `enhanceProfile` | `asr` or `master` | `asr` | Enhancement post-processing profile |
| `enhanceOptions.declick` | boolean | `false` | Declicking in the enhancement chain |
| `enhanceOptions.humNotch` | boolean | `true` | Mains-hum analysis/notching |
| `enhanceOptions.howlNotch` | boolean | `false` | Feedback-howl notching |
| `enhanceOptions.dfnAttenLimDb` | number | unset | DeepFilterNet attenuation limit (0-40) |
| `enhanceOptions.loudnessTargetLufs` | number | `-16` | loudnorm target (master profile) |
| `allowUpload` | boolean | `false` | Consent for remote enhancers |
| `maxDurationSeconds` | number | `1200` | Split files longer than this threshold |
| `keepIntermediateFiles` | boolean | `false` | Keep temp files with `--keep-temp` |
| `tempFolder` | string | `<outputFolder>/temp` | Temp working folder |
| `outputFormats` | `txt`, `srt`, or both | `txt,srt` | Output transcript formats |
| `openaiApiKey` | string | env/flag | API key for OpenAI backend |
| `localWhisperCommand` | string | env/flag | Override command for local Whisper |

## Commands

### `transcribe <input> [output]`

- Accepts either a single file or a directory.
- For a single input file, `[output]` is optional. If omitted, output files are written next to the source file.
- For a directory input, `[output]` is required.

Options:

- `-m, --model <name>`: Backend model name (depends on `--backend`; run `doctor` to list them)
- `--preset <name>`: Quality preset: `fast`, `balanced`, or `accurate`
- `-d, --device <type>`: Processing device: `auto`, `cuda`, or `cpu`
- `-b, --backend <name>`: Transcription backend: `whisper-local`, `parakeet`, or `whisper-api`
- `--enhance [engine]`: Enhance audio before transcription; engine: `basic` (default), `deepfilternet`, `unise`
- `--enhance-profile <profile>`: Enhancement post-processing: `asr` (default) or `master`
- `--declick`: Add declicking to the enhancement chain
- `--no-hum-notch`: Skip mains-hum analysis/notching during enhancement
- `--howl-notch`: Also notch sustained feedback howls
- `--dfn-atten <dB>`: DeepFilterNet attenuation limit (0-40)
- `--enhance-audio`: deprecated alias for `--enhance basic` (hidden from help)
- `--split-threshold <seconds>`: Split files longer than this duration before transcription
- `--keep-temp`: Keep intermediate files in the temp folder
- `-f, --format <formats>`: Comma-separated output formats, such as `txt`, `srt`, or `txt,srt`
- `--json`: Emit machine-readable output to stdout and NDJSON progress events to stderr

### `enhance <input> [output]`

Standalone enhancement: produce cleaned audio without transcribing, e.g. to audition the result before committing to an enhanced transcription run.

- Same input/output rules as `transcribe` (file or folder; folder requires `[output]`)
- Writes `<name>_enhanced.wav` per input file
- Engine is chosen with `--enhancer <name>` (default `basic`); tuning flags match `transcribe` (`--enhance-profile`, `--declick`, `--no-hum-notch`, `--howl-notch`, `--dfn-atten`, `--allow-upload`), defaulting to `--enhance-profile master`
- `--report`: also writes `<name>_enhancement.json` with the exact filter stages, detected notches, and measured loudness
- `--json`: machine-readable output to stdout, progress to stderr

### `tui`

Interactive terminal UI (OpenTUI). Runs everything the CLI runs by executing the real CLI as a child process and streaming its `--json` progress events.

- Left pane: file queue — recursive scan of a directory (default: current), fuzzy filter, checkbox selection; **drag & drop or paste file/folder paths** into the terminal to stage them
- Main pane: Transcribe (backend, model, preset, formats, output dir, enhancement engine + profile, split), Enhance (engine, profile, report), Doctor (live readiness panel)
- `o` opens a finished output in your system app, `v` views an enhancement report, `?` shows all keys; quitting mid-run asks before killing the child process

```bash
media-transcriber tui
```

The TUI needs OpenTUI's native core: it re-execs under Bun >= 1.3.14 when available (or Node >= 26.4 with `--experimental-ffi`) and exits with a clear message otherwise. Every other subcommand works on any supported Node.

### `doctor`

- Checks `ffmpeg` and `ffprobe`
- Shows system information
- Checks readiness for the default backend, or a selected backend with `--backend <name>`
- Shows the enhancer inventory; `--enhancer <name>` checks one enhancer and makes it fatal if missing
- Accepts `--api-key` and `--whisper-command` so readiness can match a stateless transcribe invocation
- Use `--all` to show backend inventory without making optional missing backends fatal
- Use `--json` for machine-readable readiness output
- Exits with a non-zero code when the selected/default transcription path is not ready

### `setup [backend|enhancer]`

- Guides FFmpeg/ffprobe installation when missing
- Guides local Whisper setup through uv tool, pipx, pip, or existing installs
- `setup parakeet` verifies or installs the NVIDIA NeMo runtime (active Python or uv-managed environment)
- `setup deepfilternet` guides the optional enhancer install (with the torchaudio<2.9 pin) and offers a smoke test
- Validates API credentials without storing secrets
- Offers an optional smoke test after readiness succeeds

### `update`

- Compares the installed version with the npm registry and updates in place
- Global npm installs: runs `npm install -g media-transcriber@latest` after confirmation (`--yes` to skip)
- npx runs: prints guidance (use `npx media-transcriber@latest`); git checkouts: prints the `git pull` workflow
- `--check`: only report whether a new version is available

## Audio Enhancement

Opt-in preprocessing for degraded sources (cassettes, field recordings, noisy rooms). Off by default: modern Whisper is noise-robust, and aggressive denoising can occasionally hurt accuracy on already-usable audio — for best results, A/B a sample with and without `--enhance`.

Engines (`--enhance <engine>`):

| Engine | Extras needed | What it does |
| ------ | ------------- | ------------ |
| `basic` | none | ffmpeg spectral denoise (`afftdn`) plus analysis-driven mains-hum notch filters |
| `deepfilternet` | optional install (`setup deepfilternet`) | DeepFilterNet 3 neural speech enhancement (MIT); CPU real-time capable, GPU optional |
| `unise` | none (remote) | UniSE restoration via a public Hugging Face Space. **Experimental**: uploads your audio (`--allow-upload` required), may sleep or rate-limit |

Every engine shares the same chain: optional `adeclick` → `highpass` 70 Hz → hum notches (auto-detected, e.g. 48.4 Hz on tape with speed flutter) → engine denoise → optional howl notches (`--howl-notch`). The `asr` profile stops there; `master` (default for the `enhance` command) adds compression, limiting, and two-pass loudness normalization to −16 LUFS for listening or archival.

Transparency: the exact ffmpeg filter stages and engine command used per file are recorded in a per-file enhancement report, included in `--json` results under `enhancement` and written to `<name>_enhancement.json` via `enhance --report`, so any enhancement step can be reproduced manually.

## AI Agent Integration

### Structured JSON

```bash
media-transcriber transcribe ./data/input ./data/output --json 2>/dev/null
```

### Progress Events (stderr)

In `--json` mode, NDJSON progress events are emitted to stderr.

Example:

```bash
media-transcriber transcribe ./data/input ./data/output --json 1>result.json
```

### Exit Codes

| Code | Meaning |
| ---- | ------- |
| `0` | Success (all files transcribed) |
| `1` | General error |
| `2` | Missing dependency |
| `3` | Configuration/argument error |
| `4` | No input files found |
| `10` | Partial success |

## Supported Formats

Input: `.m4a`, `.mp3`, `.mp4`, `.mkv`, `.wav`, `.flac`, `.ogg`, `.webm`

Output: `.txt`, `.srt`

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
```

Development workflow:

```bash
# Terminal 1: rebuild dist/ on changes
npm run dev

# Terminal 2: run the built CLI
node dist/index.js --help
node dist/index.js doctor
node dist/index.js transcribe ./test/input ./test/output
```

Available scripts:

```bash
npm run dev        # tsup --watch
npm run typecheck
npm test
npm run build
```

## License

MIT
