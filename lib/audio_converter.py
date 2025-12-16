"""Audio format conversion utilities"""

import subprocess
from pathlib import Path


def convert_to_mp3(input_file: str, output_folder: str, quality: int = 2) -> str:
    """
    Convert audio/video file to MP3 format

    Args:
        input_file: Full path to input audio/video file
        output_folder: Folder where MP3 file will be saved
        quality: MP3 quality (0-9, where 2 is high quality)

    Returns:
        Full path to converted MP3 file

    Raises:
        FileNotFoundError: If input file doesn't exist
        RuntimeError: If FFmpeg conversion fails
    """
    input_path = Path(input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    # Create output folder if it doesn't exist
    output_path = Path(output_folder)
    output_path.mkdir(parents=True, exist_ok=True)

    # Generate output filename
    output_file = output_path / f"{input_path.stem}.mp3"

    # Build ffmpeg command
    cmd = [
        'ffmpeg',
        '-i', str(input_path),
        '-vn',  # No video
        '-codec:a', 'libmp3lame',
        '-q:a', str(quality),
        '-y',  # Overwrite output file if exists
        str(output_file)
    ]

    # Run conversion
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg conversion failed: {result.stderr}")

    if not output_file.exists():
        raise RuntimeError("Conversion failed: output file not created")

    return str(output_file)
