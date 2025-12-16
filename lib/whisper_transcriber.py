"""Whisper transcription utilities"""

import subprocess
from pathlib import Path
from typing import Dict, Optional


def transcribe_audio(
    input_file: str,
    model: str,
    device: str,
    output_dir: str
) -> Dict[str, Optional[str]]:
    """
    Transcribe audio file using Whisper CLI

    Args:
        input_file: Full path to input audio file
        model: Whisper model name (e.g., large-v2, medium, small)
        device: Device to use (cuda or cpu)
        output_dir: Directory where transcription files will be saved

    Returns:
        Dictionary with 'txt_file' and 'srt_file' paths (or None if not found)

    Raises:
        FileNotFoundError: If input file doesn't exist
        RuntimeError: If Whisper transcription fails
    """
    input_path = Path(input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    # Create output directory
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    # Build Whisper command: request all output formats so we get both TXT and SRT
    cmd = [
        'whisper',
        str(input_path),
        '--model', model,
        '--device', device,
        '--output_dir', str(output_path),
        '--output_format', 'all',
        '--verbose', 'False'
    ]

    # Run Whisper
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise RuntimeError(f"Whisper transcription failed: {result.stderr}")

    # Find output files
    txt_files = list(output_path.glob("*.txt"))
    srt_files = list(output_path.glob("*.srt"))

    # If TXT is missing or empty but SRT exists, generate TXT from SRT as a fallback
    if (not txt_files or (txt_files and txt_files[0].stat().st_size == 0)) and srt_files:
        srt_path = srt_files[0]
        txt_path = output_path / f"{input_path.stem}.txt"

        # Extract only the subtitle text lines from SRT
        with open(srt_path, 'r', encoding='utf-8') as f:
            srt_lines = f.readlines()

        text_lines = []
        for line in srt_lines:
            stripped = line.strip()
            # Skip index lines and timestamp lines
            if not stripped:
                continue
            if stripped.isdigit():
                continue
            if '-->' in stripped:
                continue
            text_lines.append(stripped)

        # Write fallback TXT
        with open(txt_path, 'w', encoding='utf-8') as f:
            f.write('\n\n'.join(text_lines))

        # Refresh txt_files list
        txt_files = list(output_path.glob("*.txt"))

    return {
        'txt_file': str(txt_files[0]) if txt_files else None,
        'srt_file': str(srt_files[0]) if srt_files else None
    }
