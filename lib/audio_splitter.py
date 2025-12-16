"""Audio splitting utilities"""

import subprocess
from pathlib import Path
from typing import List


def get_audio_duration(input_file: str) -> float:
    """
    Get duration of audio file in seconds

    Args:
        input_file: Full path to audio file

    Returns:
        Duration in seconds

    Raises:
        FileNotFoundError: If input file doesn't exist
        RuntimeError: If ffprobe fails
    """
    input_path = Path(input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    cmd = [
        'ffprobe',
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        str(input_path)
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")

    try:
        duration = float(result.stdout.strip())
        return duration
    except ValueError:
        raise RuntimeError(f"Invalid duration output: {result.stdout}")


def split_audio(
    input_file: str,
    num_parts: int,
    output_folder: str,
    output_prefix: str = ""
) -> List[str]:
    """
    Split audio file into multiple parts

    Args:
        input_file: Full path to input audio file
        num_parts: Number of parts to split into
        output_folder: Folder where split files will be saved
        output_prefix: Prefix for output files (defaults to input filename)

    Returns:
        List of full paths to split audio files

    Raises:
        FileNotFoundError: If input file doesn't exist
        ValueError: If num_parts < 1
        RuntimeError: If ffmpeg split fails
    """
    input_path = Path(input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    if num_parts < 1:
        raise ValueError("num_parts must be at least 1")

    # Create output folder
    output_path = Path(output_folder)
    output_path.mkdir(parents=True, exist_ok=True)

    # Use input filename if no prefix specified
    if not output_prefix:
        output_prefix = input_path.stem

    # Get duration
    duration = get_audio_duration(input_file)
    part_duration = int(duration / num_parts)

    split_files = []

    # Split the file
    for i in range(1, num_parts + 1):
        start_time = (i - 1) * part_duration
        output_file = output_path / f"{output_prefix}_part{i:02d}{input_path.suffix}"

        if i == num_parts:
            # Last part: go to end of file
            cmd = [
                'ffmpeg',
                '-i', str(input_path),
                '-ss', str(start_time),
                '-c', 'copy',
                '-y',
                str(output_file)
            ]
        else:
            # Other parts: specify duration
            cmd = [
                'ffmpeg',
                '-i', str(input_path),
                '-ss', str(start_time),
                '-t', str(part_duration),
                '-c', 'copy',
                '-y',
                str(output_file)
            ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True
        )

        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg split failed for part {i}: {result.stderr}")

        if not output_file.exists():
            raise RuntimeError(f"Split failed: part {i} not created")

        split_files.append(str(output_file))

    return split_files
