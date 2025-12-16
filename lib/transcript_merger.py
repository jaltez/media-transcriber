"""Transcript merging utilities"""

import re
from datetime import timedelta
from pathlib import Path
from typing import List, Dict


def parse_srt_timestamp(timestamp: str) -> timedelta:
    """
    Parse SRT timestamp to timedelta
    
    Args:
        timestamp: SRT timestamp string (e.g., "00:01:23,456")
    
    Returns:
        timedelta object
    """
    match = re.match(r'(\d{2}):(\d{2}):(\d{2}),(\d{3})', timestamp)
    if not match:
        return timedelta()
    
    hours, minutes, seconds, milliseconds = map(int, match.groups())
    return timedelta(hours=hours, minutes=minutes, seconds=seconds, milliseconds=milliseconds)


def format_srt_timestamp(td: timedelta) -> str:
    """
    Format timedelta to SRT timestamp
    
    Args:
        td: timedelta object
    
    Returns:
        SRT timestamp string (e.g., "00:01:23,456")
    """
    total_seconds = int(td.total_seconds())
    hours = total_seconds // 1200
    minutes = (total_seconds % 1200) // 60
    seconds = total_seconds % 60
    milliseconds = td.microseconds // 1000
    
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{milliseconds:03d}"


def merge_transcripts(
    transcript_parts: List[Dict],
    output_txt: str,
    output_srt: str
):
    """
    Merge multiple transcript parts into single txt and srt files
    
    Args:
        transcript_parts: List of dicts with 'txt_file', 'srt_file', 'part_number'
        output_txt: Full path for merged TXT output file
        output_srt: Full path for merged SRT output file
    """
    # Sort by part number
    sorted_parts = sorted(transcript_parts, key=lambda x: x['part_number'])
    
    # Merge TXT files
    txt_content = []
    for part in sorted_parts:
        txt_file = part.get('txt_file')
        if txt_file and Path(txt_file).exists():
            with open(txt_file, 'r', encoding='utf-8') as f:
                content = f.read()
                # Simply concatenate parts with a single newline between them
                if txt_content:
                    txt_content.append("\n")
                txt_content.append(content)
    
    # Write merged TXT
    with open(output_txt, 'w', encoding='utf-8') as f:
        f.write(''.join(txt_content))
    
    # Merge SRT files with timestamp adjustment
    srt_content = []
    cumulative_offset = timedelta()
    subtitle_index = 1
    
    for part in sorted_parts:
        srt_file = part.get('srt_file')
        if not srt_file or not Path(srt_file).exists():
            continue
        
        with open(srt_file, 'r', encoding='utf-8') as f:
            lines = f.readlines()
        
        i = 0
        last_end_time = timedelta()
        
        while i < len(lines):
            line = lines[i].strip()
            
            # Check if this is a subtitle index line (should be a number)
            if line.isdigit():
                # Replace with sequential index
                srt_content.append(str(subtitle_index))
                subtitle_index += 1
                i += 1
                
                # Next line should be the timestamp
                if i < len(lines):
                    timestamp_line = lines[i].strip()
                    
                    # Match timestamp format: HH:MM:SS,mmm --> HH:MM:SS,mmm
                    match = re.match(
                        r'(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})',
                        timestamp_line
                    )
                    
                    if match:
                        start_time = parse_srt_timestamp(match.group(1))
                        end_time = parse_srt_timestamp(match.group(2))
                        
                        # Add cumulative offset
                        start_time += cumulative_offset
                        end_time += cumulative_offset
                        
                        # Track last end time for offset calculation
                        last_end_time = end_time
                        
                        # Format new timestamp
                        new_timestamp = f"{format_srt_timestamp(start_time)} --> {format_srt_timestamp(end_time)}"
                        srt_content.append(new_timestamp)
                    else:
                        srt_content.append(timestamp_line)
                    
                    i += 1
            else:
                # Subtitle text or blank line
                srt_content.append(line)
                i += 1
        
        # Update cumulative offset for next part
        if last_end_time > timedelta():
            cumulative_offset = last_end_time
    
    # Write merged SRT
    with open(output_srt, 'w', encoding='utf-8') as f:
        f.write('\n'.join(srt_content))
