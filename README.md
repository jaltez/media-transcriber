# Audio Transcription Batch Processor

Automated pipeline for batch transcribing audio and video files using Whisper AI.

## Features

- **Multi-format support**: m4a, mp3, mp4, mkv, wav
- **Automatic splitting**: Splits long files to prevent Whisper failures
- **Audio enhancement**: Optional noise reduction and normalization
- **Batch processing**: Process entire folders at once
- **Smart merging**: Automatically combines split transcripts with adjusted SRT timestamps
- **Flexible configuration**: Interactive mode, config file, or command-line parameters

## Prerequisites

- **FFmpeg**: For audio/video conversion and processing
- **Whisper**: For speech-to-text transcription
- **Python 3.8+**

### Installation

1. Install FFmpeg: <https://ffmpeg.org/download.html>

2. Install Whisper and Python dependencies:

   ```bash
   pip install -r requirements.txt
   ```

## Quick Start

### Python Version

**Interactive Mode:**

```bash
python transcribe_batch.py --interactive
```

**Direct Usage:**

```bash
python transcribe_batch.py -i ./input -o ./output
```

### Using Config File

Create or edit `config.json` with your preferences:

```json
{
  "input_folder": "./input",
  "output_folder": "./output",
  "whisper_model": "large-v2",
  "device": "cuda",
  "max_duration_seconds": 1200,
  "enable_audio_enhancement": false,
  "keep_intermediate_files": false
}
```

**Python:**

```bash
python transcribe_batch.py -c config.json
```

## Usage Examples

### Python Examples

**Basic Usage:**

```bash
# Process all files in input/ folder with defaults
python transcribe_batch.py -i ./input
```

**With Audio Enhancement:**

```bash
# Enable noise reduction and normalization
python transcribe_batch.py -i ./input --enhance
```

**Custom Settings:**

```bash
# Use medium model on CPU, split at 30 minutes
python transcribe_batch.py \
  -i ./recordings \
  -o ./transcripts \
  -m medium \
  -d cpu \
  --max-duration 1800
```

**Keep Intermediate Files:**

```bash
# Keep converted MP3s and split files for debugging
python transcribe_batch.py -i ./input --keep-temp
```

## Configuration Options

### Python Command-Line Arguments

| Argument         | Description                                   |
| ---------------- | --------------------------------------------- |
| `-c, --config`   | Path to configuration JSON file               |
| `-i, --input`    | Input folder containing audio/video files     |
| `-o, --output`   | Output folder for transcripts                 |
| `-m, --model`    | Whisper model (e.g., large-v2, medium, small) |
| `-d, --device`   | Processing device (cuda or cpu)               |
| `--max-duration` | Max duration before split (seconds)           |
| `--enhance`      | Enable audio enhancement                      |
| `--keep-temp`    | Keep intermediate files                       |
| `--interactive`  | Run in interactive mode                       |

### Config File Format

Both versions support JSON configuration files:

```json
{
  "input_folder": "./input",
  "output_folder": "./output",
  "whisper_model": "large-v2",
  "device": "cuda",
  "max_duration_seconds": 1200,
  "enable_audio_enhancement": false,
  "keep_intermediate_files": false
}
```

**Note:** Configuration file keys use snake_case to match the Python implementation.

## How It Works

1. **Discovery**: Finds all supported audio/video files in input folder
2. **Conversion**: Converts non-MP3 files to high-quality MP3
3. **Duration Check**: Analyzes audio length
4. **Splitting** (if needed): Divides long files into manageable parts
5. **Enhancement** (optional): Applies audio filters
6. **Transcription**: Runs Whisper on each part
7. **Merging**: Combines split transcripts with adjusted timestamps
8. **Cleanup**: Removes temporary files (unless kept)

## Folder Structure

```text
media-transcriber/
├── transcribe_batch.py        # Python main script
├── config.json                # Configuration file
├── requirements.txt           # Python dependencies
├── lib/                       # Library modules (Python)
│   ├── audio_converter.py     # Format conversion
│   ├── audio_splitter.py      # Audio splitting
│   ├── audio_enhancer.py      # Audio enhancement
│   ├── whisper_transcriber.py # Whisper wrapper
│   └── transcript_merger.py   # Transcript merging
├── input/                     # Place your audio/video files here
├── output/                    # Final transcripts appear here
└── temp/                      # Temporary files (auto-cleaned)
```

## Output Files

For each input file, you'll get:

- `filename.txt` - Plain text transcript
- `filename.srt` - Subtitle file with timestamps

## Troubleshooting

### "ffmpeg not found"

Add FFmpeg to your PATH or install via package manager:

**Windows:**

```powershell
winget install ffmpeg
```

**Linux/Mac:**

```bash
# Ubuntu/Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg
```

### "whisper not found"

Ensure Whisper is installed and in PATH:

```bash
pip install -U openai-whisper
whisper --help
```

### Out of Memory Errors

- Use a smaller model: `medium` or `small`
- Reduce max duration to split files smaller
- Switch to CPU if GPU memory is insufficient

**Python:**

```bash
python transcribe_batch.py -i ./input -m medium -d cpu
```

### Poor Transcription Quality

- Try `large-v3` model for latest improvements
- Enable audio enhancement
- For non-English, add language parameter to Whisper module

## Advanced Usage

### Custom Audio Filters

**Python:** Edit [lib/audio_enhancer.py](lib/audio_enhancer.py) to adjust the `audio_filter` variable.

**Python:** Edit [lib/audio_enhancer.py](lib/audio_enhancer.py) to adjust the `audio_filter` variable.

### Different Whisper Parameters

**Python:** Edit [lib/whisper_transcriber.py](lib/whisper_transcriber.py) to add language, task, or other Whisper options.

**Python:** Edit [lib/whisper_transcriber.py](lib/whisper_transcriber.py) to add language, task, or other Whisper options.

### Batch Processing Specific Files

**Python:**

```bash
# Process only MP4 files
python transcribe_batch.py -i ./videos
```

## Performance Tips

- **GPU acceleration**: Use CUDA device with NVIDIA GPU (10-20x faster)
- **Model selection**: `large-v2` is most accurate but slowest; `medium` is good balance
- **Batch timing**: Process overnight for large batches
- **Audio enhancement**: Adds ~30% processing time but improves accuracy

## Which Version to Use?

### Use Python

- You prefer cross-platform compatibility
- You're familiar with Python ecosystem
- You want easier extensibility
- You need to integrate with other Python tools

## License

This is a utility script for personal use. Whisper is licensed under MIT by OpenAI.

## Support

For issues with:

- **Whisper**: <https://github.com/openai/whisper>
- **FFmpeg**: <https://ffmpeg.org/>
- **This script**: Check the script comments or modify as needed
