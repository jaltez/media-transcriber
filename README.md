# media-transcriber

Transcribe audio and video files to text and subtitles using pluggable AI backends, including local Whisper and the OpenAI Whisper API.

## Quick Start

```bash
# Run directly with npx (no install)
npx media-transcriber doctor

# Or install globally
npm install -g media-transcriber

# Check your machine
media-transcriber doctor

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
- `whisper-local`: A local Whisper installation available on your system. This can be managed with [uv](https://docs.astral.sh/uv/), `pip`, or another Python environment setup.
- `whisper-api`: OpenAI API key (`OPENAI_API_KEY` env var or `--api-key`)

## Usage

### Transcribe

```bash
# Single file, output written next to the input file
media-transcriber transcribe ./recordings/interview.mp4

# Single file, explicit output folder
media-transcriber transcribe ./recordings/interview.mp4 ./transcripts

# Folder input
media-transcriber transcribe ./recordings ./transcripts

# Model and device
media-transcriber transcribe ./data/input ./data/output -m medium -d cpu

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

Check system dependencies and backend availability:

```bash
media-transcriber doctor
```

## Execution Options

All parameters are passed at execution time (stateless CLI).

| Field | Type | Default | Description |
| ---- | ---- | ---- | ---- |
| `input` | string | required | Input file or folder |
| `output` | string | optional for files, required for folders | Output folder |
| `backend` | string | `whisper-local` | Transcription backend |
| `whisperModel` | string | `large-v2` | Model name |
| `device` | `cuda` or `cpu` | `cuda` | Processing device |
| `maxDurationSeconds` | number | `1200` | Split files longer than this threshold |
| `enableAudioEnhancement` | boolean | `false` | Enable enhancement filters |
| `keepIntermediateFiles` | boolean | `false` | Keep temp files with `--keep-temp` |
| `tempFolder` | string | `<outputFolder>/temp` | Temp working folder |
| `outputFormats` | `txt`, `srt`, or both | `txt,srt` | Output transcript formats |
| `openaiApiKey` | string | env/flag | API key for OpenAI backend |

## Commands

### `transcribe <input> [output]`

- Accepts either a single file or a directory.
- For a single input file, `[output]` is optional. If omitted, output files are written next to the source file.
- For a directory input, `[output]` is required.

Options:

- `-m, --model <name>`: Whisper model name
- `-d, --device <type>`: Processing device, typically `cuda` or `cpu`
- `-b, --backend <name>`: Transcription backend
- `--split-threshold <seconds>`: Split files longer than this duration before transcription
- `--enhance-audio`: Apply audio enhancement before transcription
- `--keep-temp`: Keep intermediate files in the temp folder
- `--api-key <key>`: API key for API-based backends
- `-f, --format <formats>`: Comma-separated output formats, such as `txt`, `srt`, or `txt,srt`
- `--json`: Emit machine-readable output to stdout and NDJSON progress events to stderr

### `doctor`

- Checks `ffmpeg` and `ffprobe`
- Shows system information
- Checks registered backends and reports availability
- Exits with a non-zero code when required dependencies are missing

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
