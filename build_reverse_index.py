#!/usr/bin/env python3
"""Build a static reverse index over source lines in PluginHub JSON files."""

import gzip
import os
import heapq
import json
import re
import shutil
import struct
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from array import array
from pathlib import Path

MAGIC = b"RVS1"
VERSION = 1
HEADER = struct.Struct("<4sIQIIQQQQQQQQ")
GRAM_ENTRY = struct.Struct("<3sB QII")
GRAM_WIDTHS = (3,)
MAX_SOURCE_BYTES = 8 * 1024 * 1024
UINT32_MAX = (1 << 32) - 1
SORT_BATCH_SIZE = 1_000_000
SORT_MERGE_FAN_IN = 48


def _write_varint(output, value):
    while value >= 0x80:
        output.append((value & 0x7F) | 0x80)
        value >>= 7
    output.append(value)


def _source_lines(content):
    if not content:
        return []
    lines = re.split(r"\r\n|\n|\r", content)
    if content.endswith(("\r", "\n")):
        lines.pop()
    return enumerate((line.encode("utf-8") for line in lines), start=1)


def _gram_code(gram):
    width, value = gram
    return (width << 24) | int.from_bytes(value.ljust(3, b"\0"), "big")


def _iter_sorted_run(path, line_base=0):
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            if len(block) % 8:
                raise ValueError("Corrupt temporary posting run")
            for (value,) in struct.iter_unpack("<Q", block):
                if line_base:
                    code = value >> 32
                    line_id = (value & UINT32_MAX) + line_base
                    if line_id > UINT32_MAX:
                        raise ValueError("Index exceeds version 1 32-bit line limits")
                    value = (code << 32) | line_id
                yield value


def _merge_runs(paths, output_path):
    with output_path.open("wb") as output:
        buffer = array("Q")
        for value in heapq.merge(*(_iter_sorted_run(path, line_base) for path, line_base in paths)):
            buffer.append(value)
            if len(buffer) >= 65536:
                if sys.byteorder != "little":
                    buffer.byteswap()
                output.write(buffer.tobytes())
                if sys.byteorder != "little":
                    buffer.byteswap()
                buffer = array("Q")
        if buffer:
            if sys.byteorder != "little":
                buffer.byteswap()
            output.write(buffer.tobytes())


def _merge_run_batch(task):
    paths, output_path = task
    _merge_runs([(Path(path), line_base) for path, line_base in paths], Path(output_path))
    return output_path


def _write_sorted_run(values, run_path):
    values.sort()
    packed = array("Q", values)
    if sys.byteorder != "little":
        packed.byteswap()
    with run_path.open("wb") as output:
        output.write(packed.tobytes())


def _process_plugin(task):
    json_path, temporary_directory, plugin_index = task
    json_path = Path(json_path)
    temporary_directory = Path(temporary_directory)
    try:
        data = json.loads(json_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not parse {json_path}: {error}") from error
    if not isinstance(data, dict) or not isinstance(data.get("files", []), list):
        raise ValueError(f"Invalid plugin JSON structure: {json_path}")

    plugin_name = json_path.stem
    repository = data.get("repository") or ""
    commit = data.get("commit") or ""
    file_entries = []
    run_paths = []
    line_count = 0
    sort_values = []
    text_spool_path = temporary_directory / f"plugin-{plugin_index:05d}.text"

    with text_spool_path.open("wb") as text_spool:
        for source in data.get("files", []):
            if not isinstance(source, dict) or not isinstance(source.get("content"), str):
                continue
            content = source["content"]
            content_bytes = content.encode("utf-8")
            if len(content_bytes) > MAX_SOURCE_BYTES:
                raise ValueError(
                    f"Source block exceeds {MAX_SOURCE_BYTES} bytes: "
                    f"{json_path} / {source.get('filePath', '')}"
                )

            compressed = gzip.compress(content_bytes, compresslevel=6, mtime=0)
            text_offset = text_spool.tell()
            text_spool.write(compressed)
            first_line = line_count
            file_entry = {
                "plugin": plugin_name,
                "repository": repository,
                "commit": commit,
                "path": source.get("filePath") or source.get("fileName") or "",
                "firstLine": first_line,
                "lineCount": 0,
                "offset": text_offset,
                "compressedSize": len(compressed),
                "rawSize": len(content_bytes),
            }

            for _, line_bytes in _source_lines(content):
                if line_count > UINT32_MAX:
                    raise ValueError("Index exceeds version 1 32-bit line limits")
                normalized = line_bytes.decode("utf-8").lower().encode("utf-8")
                grams = {
                    (width, normalized[index:index + width])
                    for width in GRAM_WIDTHS
                    for index in range(max(0, len(normalized) - width + 1))
                }
                for gram in grams:
                    sort_values.append((_gram_code(gram) << 32) | line_count)
                if len(sort_values) >= SORT_BATCH_SIZE:
                    run_path = temporary_directory / f"plugin-{plugin_index:05d}-sort-{len(run_paths):05d}.bin"
                    _write_sorted_run(sort_values, run_path)
                    run_paths.append(run_path)
                    sort_values = []
                line_count += 1
            file_entry["lineCount"] = line_count - first_line
            file_entries.append(file_entry)

    if sort_values:
        run_path = temporary_directory / f"plugin-{plugin_index:05d}-sort-{len(run_paths):05d}.bin"
        _write_sorted_run(sort_values, run_path)
        run_paths.append(run_path)

    return {
        "lineCount": line_count,
        "files": file_entries,
        "runs": [str(path) for path in run_paths],
        "textSpool": str(text_spool_path),
        "textSize": text_spool_path.stat().st_size,
    }


def build_index(source_dir, output_path, workers=None):
    source_dir = Path(source_dir).resolve()
    output_path = Path(output_path).resolve()
    if output_path.is_dir():
        output_path = output_path / "search.ridx"
    plugin_files = sorted(path for path in source_dir.rglob("*.json") if path.is_file())
    if not plugin_files:
        raise ValueError(f"No plugin JSON files found under {source_dir}")

    with tempfile.TemporaryDirectory(prefix="reverse-index-") as temporary_directory:
        temporary_directory = Path(temporary_directory)
        posting_spool_path = temporary_directory / "postings.spool"
        run_paths = []
        text_spool_path = temporary_directory / "text.spool"
        file_entries = []
        line_count = 0
        text_size = 0
        worker_count = min(os.cpu_count() or 1, 8) if workers is None else workers
        if worker_count < 1:
            raise ValueError("Worker count must be at least one")
        worker_count = min(worker_count, len(plugin_files))
        tasks = (
            (str(path), str(temporary_directory), index)
            for index, path in enumerate(plugin_files)
        )

        with ProcessPoolExecutor(max_workers=worker_count) as executor, text_spool_path.open("wb") as text_spool:
            for processed_count, result in enumerate(executor.map(_process_plugin, tasks, chunksize=1), start=1):
                for file_entry in result["files"]:
                    file_entry["firstLine"] += line_count
                    file_entry["offset"] += text_size
                    file_entries.append(file_entry)
                with Path(result["textSpool"]).open("rb") as plugin_text:
                    shutil.copyfileobj(plugin_text, text_spool, length=1024 * 1024)
                text_size += result["textSize"]
                run_paths.extend((Path(run_path), line_count) for run_path in result["runs"])
                line_count += result["lineCount"]
                if processed_count % 250 == 0 or processed_count == len(plugin_files):
                    print(f"Processed {processed_count:,}/{len(plugin_files):,} plugins", flush=True)

        if line_count == 0:
            raise ValueError("No source lines found; verify plugin JSON files contain non-empty files[].content values")

        merge_number = 0
        while len(run_paths) > SORT_MERGE_FAN_IN:
            merge_tasks = []
            for start in range(0, len(run_paths), SORT_MERGE_FAN_IN):
                batch = run_paths[start:start + SORT_MERGE_FAN_IN]
                merged_path = temporary_directory / f"merge-{merge_number:03d}-{len(merge_tasks):06d}.bin"
                merge_tasks.append((
                    [(str(path), line_base) for path, line_base in batch],
                    str(merged_path),
                ))
            print(
                f"Merging posting runs: pass {merge_number + 1}, "
                f"{len(run_paths):,} runs -> {len(merge_tasks):,} runs",
                flush=True,
            )
            with ProcessPoolExecutor(max_workers=min(worker_count, len(merge_tasks))) as executor:
                merged_paths = list(executor.map(_merge_run_batch, merge_tasks, chunksize=1))
            for path, _ in run_paths:
                path.unlink()
            run_paths = [(Path(path), 0) for path in merged_paths]
            merge_number += 1

        print(f"Encoding postings from {len(run_paths):,} merged runs", flush=True)
        gram_entries = []
        with posting_spool_path.open("wb") as posting_spool:
            encoded_postings = bytearray()
            current_code = None
            previous_line = -1
            posting_count = 0

            def flush_posting():
                if current_code is None:
                    return
                compressed = gzip.compress(bytes(encoded_postings), compresslevel=6, mtime=0)
                posting_offset = posting_spool.tell()
                posting_spool.write(compressed)
                width = (current_code >> 24) & 0xff
                gram_bytes = (current_code & 0xffffff).to_bytes(3, "big")[:width]
                gram_entries.append((width, gram_bytes, posting_offset, len(compressed), posting_count))

            merged_values = heapq.merge(*(_iter_sorted_run(path, line_base) for path, line_base in run_paths))
            for value in merged_values:
                code = value >> 32
                line_id = value & UINT32_MAX
                if code != current_code:
                    flush_posting()
                    current_code = code
                    encoded_postings = bytearray()
                    previous_line = -1
                    posting_count = 0
                _write_varint(encoded_postings, line_id - previous_line)
                previous_line = line_id
                posting_count += 1
            flush_posting()
            postings_size = posting_spool.tell()

        dictionary = bytearray()
        for width, gram, posting_offset, compressed_size, count in gram_entries:
            dictionary.extend(GRAM_ENTRY.pack(gram.ljust(3, b"\0"), width, posting_offset, compressed_size, count))

        file_table = json.dumps(file_entries, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        dictionary_offset = HEADER.size
        dictionary_size = len(dictionary)
        postings_offset = dictionary_offset + dictionary_size
        file_table_offset = postings_offset + postings_size
        text_offset = file_table_offset + len(file_table)
        header = HEADER.pack(
            MAGIC,
            VERSION,
            line_count,
            len(gram_entries),
            len(file_entries),
            dictionary_offset,
            dictionary_size,
            postings_offset,
            postings_size,
            file_table_offset,
            len(file_table),
            text_offset,
            text_size,
        )

        output_path.parent.mkdir(parents=True, exist_ok=True)
        with output_path.open("wb") as output:
            output.write(header)
            output.write(dictionary)
            with posting_spool_path.open("rb") as spool:
                while block := spool.read(1024 * 1024):
                    output.write(block)
            output.write(file_table)
            with text_spool_path.open("rb") as spool:
                while block := spool.read(1024 * 1024):
                    output.write(block)

    return {
        "lines": line_count,
        "grams": len(gram_entries),
        "files": len(file_entries),
        "bytes": output_path.stat().st_size,
        "workers": worker_count,
        "output": output_path,
    }


def main():
    if len(sys.argv) not in (3, 4):
        print("Usage: python3 build_reverse_index.py <plugins-data-dir> <output-index-or-dir> [workers]", file=sys.stderr)
        return 2
    try:
        worker_count = int(sys.argv[3]) if len(sys.argv) == 4 else None
        stats = build_index(sys.argv[1], sys.argv[2], worker_count)
    except (OSError, ValueError) as error:
        print(f"Index build failed: {error}", file=sys.stderr)
        return 1
    print(f"Wrote {stats['output']}")
    print(f"  Source lines: {stats['lines']:,}")
    print(f"  Trigram postings: {stats['grams']:,}")
    print(f"  Source files: {stats['files']:,}")
    print(f"  Workers: {stats['workers']}")
    print(f"  Artifact size: {stats['bytes'] / 1024 / 1024:.1f} MiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())