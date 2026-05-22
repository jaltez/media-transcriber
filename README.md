# media-transcriber

Transcribe audio and video files to text and subtitles using pluggable AI backends, including local Whisper and the OpenAI Whisper API.

## Quick Start

```bash
# Run directly with npx (no install)
npx media-transcriber doctor

# Or install globally
npm install -g media-transcriber

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

# Custom local Whisper command
media-transcriber transcribe ./meeting.mp4 --whisper-command "whisper"

# OpenAI API backend
media-transcriber transcribe ./data/input ./data/output -b whisper-api --api-key <key>

# Split long files before transcription
media-transcriber transcribe ./data/input ./data/output --split-threshold 900

# Enable audio enhancement
media-transcriber transcribe ./data/input ./data/output --enhance-audio

# Keep temporary files in ./data/output/temp
media-transcriber transcribe ./data/input ./data/output --keep-temp

# Output only subtitles
media-transcriber transcribe ./data/input ./data/output -f srt

# JSON output for agents
media-transcriber transcribe ./data/input ./data/output --json
```

### Doctor

Check readiness for the default or selected transcription path:

```bash
media-transcriber doctor
media-transcriber doctor --backend whisper-api
media-transcriber doctor --backend whisper-api --api-key <key>
media-transcriber doctor --whisper-command "whisper"
media-transcriber doctor --all
media-transcriber doctor --json
```

### Setup

Run guided setup when readiness fails:

```bash
media-transcriber setup whisper-local
media-transcriber setup whisper-api
```

Setup can offer to run package managers after confirmation, validates the result, and can run an optional smoke test. It does not write Media Transcriber config files or store API keys.

## Execution Options

All parameters are passed at execution time (stateless CLI).

| Field | Type | Default | Description |
| ---- | ---- | ---- | ---- |
| `input` | string | required | Input file or folder |
| `output` | string | optional for files, required for folders | Output folder |
| `backend` | string | `whisper-local` | Transcription backend |
| `whisperModel` | string | backend default | Model name |
| `preset` | `fast`, `balanced`, or `accurate` | unset | Friendly quality preset |
| `device` | `auto`, `cuda`, or `cpu` | `auto` | Processing device policy |
| `maxDurationSeconds` | number | `1200` | Split files longer than this threshold |
| `enableAudioEnhancement` | boolean | `false` | Enable enhancement filters |
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

- `-m, --model <name>`: Backend model name
- `--preset <name>`: Quality preset: `fast`, `balanced`, or `accurate`
- `-d, --device <type>`: Processing device: `auto`, `cuda`, or `cpu`
- `-b, --backend <name>`: Transcription backend
- `--split-threshold <seconds>`: Split files longer than this duration before transcription
- `--enhance-audio`: Apply audio enhancement before transcription
- `--keep-temp`: Keep intermediate files in the temp folder
- `--api-key <key>`: API key for API-based backends
- `--whisper-command <command>`: Override local Whisper command; can also use `MEDIA_TRANSCRIBER_WHISPER_COMMAND`
- `-f, --format <formats>`: Comma-separated output formats, such as `txt`, `srt`, or `txt,srt`
- `--json`: Emit machine-readable output to stdout and NDJSON progress events to stderr

### `doctor`

- Checks `ffmpeg` and `ffprobe`
- Shows system information
- Checks readiness for the default backend, or a selected backend with `--backend <name>`
- Accepts `--api-key` and `--whisper-command` so readiness can match a stateless transcribe invocation
- Use `--all` to show backend inventory without making optional missing backends fatal
- Use `--json` for machine-readable readiness output
- Exits with a non-zero code when the selected/default transcription path is not ready

### `setup [backend]`

- Guides FFmpeg/ffprobe installation when missing
- Guides local Whisper setup through uv tool, pipx, pip, or existing installs
- Validates API credentials without storing secrets
- Offers an optional smoke test after readiness succeeds

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
