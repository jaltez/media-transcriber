"""Audio enhancement utilities"""

import subprocess
from pathlib import Path


def enhance_audio(input_file: str, output_folder: str) -> str:
    """
    Enhance audio quality with noise reduction and normalization

    Applies FFmpeg audio filters:
    - afftdn: FFT-based noise reduction
    - acompressor: Dynamic range compression
    - loudnorm: EBU R128 loudness normalization

    Args:
        input_file: Full path to input audio file
        output_folder: Folder where enhanced audio will be saved

    Returns:
        Full path to enhanced audio file

    Raises:
        FileNotFoundError: If input file doesn't exist
        RuntimeError: If FFmpeg enhancement fails
    """
    input_path = Path(input_file)
    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_file}")

    # Create output folder
    output_path = Path(output_folder)
    output_path.mkdir(parents=True, exist_ok=True)

    # Generate output filename
    output_file = output_path / f"{input_path.stem}_enhanced{input_path.suffix}"

    # Audio filter chain
    audio_filter = (
        "afftdn=nf=-20,"
        "acompressor=ratio=4:threshold=0.1:attack=10:release=100,"
        "loudnorm=I=-16:LRA=11:tp=-1.5"
    )

    # Build ffmpeg command
    cmd = [
        'ffmpeg',
        '-i', str(input_path),
        '-af', audio_filter,
        '-y',
        str(output_file)
    ]

    # Run enhancement
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True
    )

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio enhancement failed: {result.stderr}")

    if not output_file.exists():
        raise RuntimeError("Enhancement failed: output file not created")

    return str(output_file)
