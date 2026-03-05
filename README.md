# media-transcriber

Batch transcribe audio/video files using pluggable AI backends (Whisper local, OpenAI API, and more).

## Quick Start

```bash
# Run directly with npx (no install)
npx media-transcriber setup

# Or install globally
npm install -g media-transcriber

# Transcribe files
media-transcriber transcribe -i ./data/input -o ./data/output
```

## Requirements

- **Node.js** >= 18
- **FFmpeg** — required for audio conversion, splitting, and enhancement
  - Windows: `winget install ffmpeg` or `scoop install ffmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`

### Backend-specific requirements

| Backend | Requirement |
| ------- | ----------- |
| `whisper-local` (default) | Python 3.10+ with `openai-whisper` installed |
| `whisper-api` | OpenAI API key (`OPENAI_API_KEY` env var) |

## Usage

### Transcribe

```bash
# Basic usage (uses config file or defaults)
media-transcriber transcribe -i ./recordings -o ./transcripts

# Specify model and device
media-transcriber transcribe -i ./data/input -m medium -d cpu

# Use OpenAI API instead of local Whisper
media-transcriber transcribe -b whisper-api -i ./data/input

# JSON output for AI agents
media-transcriber transcribe -i ./data/input --json

# Enable audio enhancement (noise reduction + normalization)
media-transcriber transcribe -i ./data/input --enhance
```

### Setup

Interactive wizard that checks dependencies and generates a config file:

```bash
media-transcriber setup
```

### Config

```bash
# Show current effective configuration
media-transcriber config show

# Show as JSON
media-transcriber config show --json

# Generate default config file
media-transcriber config init
```

## Configuration

Config is loaded via [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig) — place any of these in your project root:

- `.media-transcriber.json`
- `.media-transcriber.yaml`
- `.media-transcriber.yml`
- `media-transcriber.config.js`
- `config.json`

### Options

| Field | Type | Default | Description |
| ----- | ---- | ------- | ----------- |
| `backend` | string | `"whisper-local"` | Transcription backend |
| `inputFolder` | string | `"./data/input"` | Folder with audio/video files |
| `outputFolder` | string | `"./data/output"` | Where transcripts are saved |
| `tempFolder` | string | `"./data/temp"` | Temporary working directory |
| `whisperModel` | string | `"large-v2"` | Model name (backend-specific) |
| `device` | `"cuda"` \| `"cpu"` | `"cuda"` | Processing device |
| `maxDurationSeconds` | number | `1200` | Split threshold (seconds) |
| `enableAudioEnhancement` | boolean | `false` | Noise reduction + loudness normalization |
| `keepIntermediateFiles` | boolean | `false` | Keep temp files after processing |
| `outputFormats` | string[] | `["txt", "srt"]` | Output formats |
| `openaiApiKey` | string | — | OpenAI API key (for whisper-api backend) |
| `pythonPath` | string | — | Custom Python executable path |

CLI arguments always override config file values.

## Backends

### `whisper-local` (default)

Uses the local [OpenAI Whisper](https://github.com/openai/whisper) installation via Python. Requires Python and `pip install openai-whisper`.

**Supported models:** tiny, base, small, medium, large, large-v2, large-v3, turbo

### `whisper-api`

Uses the [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text). No local GPU needed, but requires an API key and has a 25MB file size limit per request.

**Supported models:** whisper-1

## AI Agent Integration

The CLI is designed to be easy to invoke programmatically:

### Structured JSON output

```bash
media-transcriber transcribe -i ./data/input --json 2>/dev/null
```

Stdout will contain:

```json
{
  "files": [
    {
      "input": "./data/input/recording.mp3",
      "output": { "txt": "./data/output/recording.txt", "srt": "./data/output/recording.srt" },
      "durationSeconds": 450,
      "backend": "whisper-local",
      "model": "large-v2",
      "success": true
    }
  ],
  "summary": {
    "totalFiles": 1,
    "successful": 1,
    "failed": 0,
    "elapsed": 32000
  }
}
```

### Progress events (stderr)

When using `--json`, progress events are emitted as NDJSON to stderr:

```jsonl
{"event":"batch_start","totalFiles":2}
{"event":"file_start","file":"recording.mp3","fileNumber":1,"totalFiles":2}
{"event":"step_start","file":"recording.mp3","step":"convert"}
{"event":"step_complete","file":"recording.mp3","step":"convert"}
{"event":"step_start","file":"recording.mp3","step":"transcribe"}
{"event":"step_complete","file":"recording.mp3","step":"transcribe"}
{"event":"file_complete","file":"recording.mp3","success":true}
{"event":"batch_complete","summary":{"totalFiles":2,"successful":2,"failed":0,"elapsed":45000}}
```

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | Success — all files transcribed |
| 1 | General error |
| 2 | Missing dependency (FFmpeg, Whisper, Python) |
| 3 | Configuration error |
| 4 | No input files found |
| 10 | Partial success — some files failed |

## Supported Formats

Input: `.m4a`, `.mp3`, `.mp4`, `.mkv`, `.wav`, `.flac`, `.ogg`, `.webm`

Output: `.txt` (plain text), `.srt` (SubRip subtitles)

## Development

```bash
npm install
npm run build       # Build with tsup
npm run dev         # Build in watch mode
npm run typecheck   # Type-check without emitting
npm run test        # Run tests (vitest)
npm run test:watch  # Run tests in watch mode
```

## License

MIT
