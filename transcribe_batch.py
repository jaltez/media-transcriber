#!/usr/bin/env python3
"""
Audio Transcription Batch Processor
Automated pipeline for batch transcribing audio and video files using Whisper AI.
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

from lib.audio_converter import convert_to_mp3
from lib.audio_splitter import split_audio, get_audio_duration
from lib.audio_enhancer import enhance_audio
from lib.whisper_transcriber import transcribe_audio
from lib.transcript_merger import merge_transcripts


class Colors:
    """ANSI color codes for terminal output"""

    GREEN = "\033[92m"
    CYAN = "\033[96m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    GRAY = "\033[90m"
    RESET = "\033[0m"
    BOLD = "\033[1m"


def load_config(config_file: Optional[str] = None) -> Dict:
    """Load configuration from file or use defaults"""
    default_config = {
        "input_folder": "./input",
        "output_folder": "./output",
        "temp_folder": "./temp",
        "whisper_model": "large-v2",
        "device": "cuda",
        "max_duration_seconds": 1200,
        "enable_audio_enhancement": False,
        "keep_intermediate_files": False,
        "output_formats": ["txt", "srt"],
    }

    if config_file and Path(config_file).exists():
        print(f"{Colors.CYAN}Loading configuration from {config_file}...{Colors.RESET}")
        with open(config_file, "r") as f:
            file_config = json.load(f)
            default_config.update(file_config)

    return default_config


def interactive_config() -> Dict:
    """Get configuration through interactive prompts"""
    print(
        f"\n{Colors.GREEN}=== Audio Transcription Batch Processor ==={Colors.RESET}\n"
    )

    config = {}

    config["input_folder"] = (
        input("Input folder (default: ./input): ").strip() or "./input"
    )
    config["output_folder"] = (
        input("Output folder (default: ./output): ").strip() or "./output"
    )
    config["whisper_model"] = (
        input("Whisper model (default: large-v2): ").strip() or "large-v2"
    )
    config["device"] = input("Device (cuda/cpu, default: cuda): ").strip() or "cuda"

    duration = input("Max duration before split in seconds (default: 1200): ").strip()
    config["max_duration_seconds"] = int(duration) if duration else 1200

    enhance = input("Enable audio enhancement? (y/N): ").strip().lower()
    config["enable_audio_enhancement"] = enhance in ["y", "yes"]

    keep = input("Keep intermediate files? (y/N): ").strip().lower()
    config["keep_intermediate_files"] = keep in ["y", "yes"]

    print()
    return config


def create_directories(config: Dict):
    """Create necessary directories"""
    for folder in ["input_folder", "output_folder", "temp_folder"]:
        path = Path(config.get(folder, f"./{folder.replace('_folder', '')}"))
        if not path.exists():
            path.mkdir(parents=True, exist_ok=True)
            print(f"{Colors.YELLOW}Created directory: {path}{Colors.RESET}")


def display_config(config: Dict):
    """Display current configuration"""
    print(f"\n{Colors.GREEN}=== Configuration ==={Colors.RESET}")
    for key, value in sorted(config.items()):
        print(f"{Colors.GRAY}{key}: {value}{Colors.RESET}")
    print()


def find_input_files(input_folder: str) -> List[Path]:
    """Find all supported audio/video files in input folder"""
    supported_extensions = [".m4a", ".mp3", ".mp4", ".mkv", ".wav"]
    input_path = Path(input_folder)

    files = []
    for ext in supported_extensions:
        files.extend(input_path.rglob(f"*{ext}"))

    return sorted(files)


def process_file(
    file_path: Path, config: Dict, file_num: int, total_files: int
) -> bool:
    """Process a single audio/video file through the transcription pipeline"""
    base_name = file_path.stem
    temp_folder = Path(config["temp_folder"])
    output_folder = Path(config["output_folder"])

    print(
        f"{Colors.GREEN}[{file_num}/{total_files}] Processing: {file_path.name}{Colors.RESET}"
    )
    print("=" * 70)

    try:
        # Step 1: Convert to MP3 if needed
        if file_path.suffix == ".mp3":
            print(f"{Colors.GRAY}  [OK] Already MP3, skipping conversion{Colors.RESET}")
            mp3_file = str(file_path)
        else:
            print(f"{Colors.CYAN}  -> Converting to MP3...{Colors.RESET}")
            mp3_file = convert_to_mp3(str(file_path), str(temp_folder))
            print(f"{Colors.GREEN}  [OK] Converted to MP3{Colors.RESET}")

        # Step 2: Check duration and split if necessary
        print(f"{Colors.CYAN}  -> Checking audio duration...{Colors.RESET}")
        duration = get_audio_duration(mp3_file)

        needs_split = duration > config["max_duration_seconds"]
        audio_files = []

        if needs_split:
            num_parts = int(duration / config["max_duration_seconds"]) + 1
            print(
                f"{Colors.YELLOW}  ⚠ Duration: {int(duration)}s exceeds limit, "
                f"splitting into {num_parts} parts...{Colors.RESET}"
            )

            audio_files = split_audio(mp3_file, num_parts, str(temp_folder), base_name)
            print(
                f"{Colors.GREEN}  [OK] Split into {len(audio_files)} parts{Colors.RESET}"
            )
        else:
            print(
                f"{Colors.GREEN}  [OK] Duration: {int(duration)}s (no split needed){Colors.RESET}"
            )
            audio_files = [mp3_file]

        # Step 3: Enhance audio if requested
        if config["enable_audio_enhancement"]:
            print(f"{Colors.CYAN}  -> Enhancing audio...{Colors.RESET}")
            enhanced_files = []
            for audio_file in audio_files:
                enhanced = enhance_audio(audio_file, str(temp_folder))
                enhanced_files.append(enhanced)
            audio_files = enhanced_files
            print(f"{Colors.GREEN}  [OK] Audio enhanced{Colors.RESET}")

        # Step 4: Transcribe with Whisper
        print(
            f"{Colors.CYAN}  -> Transcribing with Whisper ({config['whisper_model']})...{Colors.RESET}"
        )
        transcript_parts = []

        for i, audio_file in enumerate(audio_files, 1):
            if len(audio_files) > 1:
                print(
                    f"{Colors.GRAY}    -> Part {i}/{len(audio_files)}...{Colors.RESET}"
                )

            output_dir = temp_folder / f"{base_name}_part{i:02d}"
            result = transcribe_audio(
                audio_file, config["whisper_model"], config["device"], str(output_dir)
            )

            transcript_parts.append(
                {
                    "txt_file": result.get("txt_file"),
                    "srt_file": result.get("srt_file"),
                    "part_number": i,
                }
            )

        print(f"{Colors.GREEN}  [OK] Transcription complete{Colors.RESET}")

        # Step 5: Merge transcripts if split
        if len(transcript_parts) > 1:
            print(f"{Colors.CYAN}  -> Merging transcript parts...{Colors.RESET}")

            final_txt = output_folder / f"{base_name}.txt"
            final_srt = output_folder / f"{base_name}.srt"

            merge_transcripts(transcript_parts, str(final_txt), str(final_srt))
            print(f"{Colors.GREEN}  [OK] Merged transcripts{Colors.RESET}")
        else:
            # Copy single files to output
            print(f"{Colors.CYAN}  -> Copying transcripts to output...{Colors.RESET}")

            if transcript_parts[0]["txt_file"]:
                import shutil

                shutil.copy2(
                    transcript_parts[0]["txt_file"], output_folder / f"{base_name}.txt"
                )
            if transcript_parts[0]["srt_file"]:
                import shutil

                shutil.copy2(
                    transcript_parts[0]["srt_file"], output_folder / f"{base_name}.srt"
                )

            print(f"{Colors.GREEN}  [OK] Copied to output{Colors.RESET}")

        print(
            f"{Colors.GREEN}  [OK][OK] {file_path.name} - COMPLETE [OK]\n{Colors.RESET}"
        )
        return True

    except Exception as e:
        print(f"{Colors.RED}  [X] ERROR: {e}{Colors.RESET}\n")
        return False


def cleanup_temp_files(temp_folder: str):
    """Remove temporary files"""
    import shutil

    temp_path = Path(temp_folder)
    if temp_path.exists():
        shutil.rmtree(temp_path)


def main():
    """Main execution function"""
    parser = argparse.ArgumentParser(
        description="Batch transcribe audio/video files using Whisper AI"
    )
    parser.add_argument("-c", "--config", help="Path to configuration JSON file")
    parser.add_argument(
        "-i", "--input", help="Input folder containing audio/video files"
    )
    parser.add_argument("-o", "--output", help="Output folder for transcripts")
    parser.add_argument(
        "-m", "--model", help="Whisper model (e.g., large-v2, medium, small)"
    )
    parser.add_argument(
        "-d", "--device", choices=["cuda", "cpu"], help="Processing device"
    )
    parser.add_argument(
        "--max-duration", type=int, help="Max duration before split (seconds)"
    )
    parser.add_argument(
        "--enhance", action="store_true", help="Enable audio enhancement"
    )
    parser.add_argument(
        "--keep-temp", action="store_true", help="Keep intermediate files"
    )
    parser.add_argument(
        "--interactive", action="store_true", help="Run in interactive mode"
    )

    args = parser.parse_args()

    # Load configuration
    config = load_config(args.config)

    # Interactive mode
    if args.interactive or (
        not args.input and not Path(config["input_folder"]).exists()
    ):
        interactive_cfg = interactive_config()
        config.update(interactive_cfg)

    # Override with command-line arguments
    if args.input:
        config["input_folder"] = args.input
    if args.output:
        config["output_folder"] = args.output
    if args.model:
        config["whisper_model"] = args.model
    if args.device:
        config["device"] = args.device
    if args.max_duration:
        config["max_duration_seconds"] = args.max_duration
    if args.enhance:
        config["enable_audio_enhancement"] = True
    if args.keep_temp:
        config["keep_intermediate_files"] = True

    # Ensure temp_folder is set
    if "temp_folder" not in config:
        config["temp_folder"] = "./temp"

    # Create directories
    create_directories(config)

    # Display configuration
    display_config(config)

    # Find input files
    input_files = find_input_files(config["input_folder"])

    if not input_files:
        print(
            f"{Colors.RED}No supported audio/video files found in {config['input_folder']}{Colors.RESET}"
        )
        print(
            f"{Colors.YELLOW}Supported formats: m4a, mp3, mp4, mkv, wav{Colors.RESET}"
        )
        return 1

    print(f"{Colors.CYAN}Found {len(input_files)} file(s) to process\n{Colors.RESET}")

    # Process each file
    failed_files = []
    for i, file_path in enumerate(input_files, 1):
        success = process_file(file_path, config, i, len(input_files))
        if not success:
            failed_files.append(file_path.name)

    # Cleanup temp folder if requested
    if not config["keep_intermediate_files"]:
        print(f"{Colors.YELLOW}Cleaning up temporary files...{Colors.RESET}")
        cleanup_temp_files(config["temp_folder"])

    # Summary
    print("\n" + "=" * 70)
    print(f"{Colors.GREEN}=== Processing Complete ==={Colors.RESET}")
    print("=" * 70)
    print(f"{Colors.CYAN}Total files: {len(input_files)}{Colors.RESET}")
    print(
        f"{Colors.GREEN}Successful: {len(input_files) - len(failed_files)}{Colors.RESET}"
    )

    if failed_files:
        print(f"{Colors.RED}Failed: {len(failed_files)}{Colors.RESET}")
        print(f"\n{Colors.RED}Failed files:{Colors.RESET}")
        for file in failed_files:
            print(f"{Colors.RED}  - {file}{Colors.RESET}")
    else:
        print(f"{Colors.GRAY}Failed: 0{Colors.RESET}")

    print(f"\n{Colors.CYAN}Output location: {config['output_folder']}{Colors.RESET}\n")

    return 0 if not failed_files else 1


if __name__ == "__main__":
    sys.exit(main())
