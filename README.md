# media-transcriber

Batch transcribe audio/video files using pluggable AI backends (Whisper local, OpenAI API, and more).

## Quick Start

```bash
# Run directly with npx (no install)
npx media-transcriber setup

# Or install globally
npm install -g media-transcriber

# Transcribe files (stateless)
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
- `whisper-api`: OpenAI API key (`OPENAI_API_KEY` env var or `--openai-api-key`)

## Usage

### Transcribe

```bash
# Basic
media-transcriber transcribe ./recordings ./transcripts

# Model and device
media-transcriber transcribe ./data/input ./data/output -m medium -d cpu

# OpenAI API backend
media-transcriber transcribe ./data/input ./data/output -b whisper-api --openai-api-key <key>

# Keep temporary files in ./data/output/temp
media-transcriber transcribe ./data/input ./data/output --include-temp

# JSON output for agents
media-transcriber transcribe ./data/input ./data/output --json
```

### Setup

Dependency check wizard (no persistent config file):

```bash
media-transcriber setup
```

## Execution Options

All parameters are passed at execution time (stateless CLI).

| Field | Type | Default | Description |
| ---- | ---- | ---- | ---- |
| `inputFolder` | string | required | Input folder argument |
| `outputFolder` | string | required | Output folder argument |
| `backend` | string | `whisper-local` | Transcription backend |
| `whisperModel` | string | `large-v2` | Model name |
| `device` | `cuda` or `cpu` | `cuda` | Processing device |
| `maxDurationSeconds` | number | `1200` | Split threshold |
| `enableAudioEnhancement` | boolean | `false` | Enable enhancement filters |
| `keepIntermediateFiles` | boolean | `false` | Keep temp files with `--include-temp` |
| `tempFolder` | string | `<outputFolder>/temp` | Temp working folder |
| `openaiApiKey` | string | env/flag | API key for OpenAI backend |

## AI Agent Integration

### Structured JSON

```bash
media-transcriber transcribe ./data/input ./data/output --json 2>/dev/null
```

### Progress Events (stderr)

In `--json` mode, NDJSON progress events are emitted to stderr.

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
npm run typecheck
npm test
npm run build
```

## License

MIT
