"""Warm, offline adapter for the already installed Study Suite speech runtime.

One subprocess owns one model for a capture session. This is a pipe worker, not
a server. It never installs packages, downloads models, or accepts file paths.
"""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import sys
import time

MODEL = 'mobiuslabsgmbh/faster-whisper-large-v3-turbo'
REVISION = '0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf'


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main():
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'): stream.reconfigure(encoding='utf-8')
    os.environ.update(HF_HUB_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', HF_HUB_DISABLE_IMPLICIT_TOKEN='1')
    # Reuse the installed toolkit's CUDA DLLs, runtime, model ID and pinned revision.
    dll = Path(sys.executable).parent.parent / 'Lib/site-packages/torch/lib'
    handles = []
    if os.name == 'nt' and dll.is_dir():
        handles.append(os.add_dll_directory(str(dll)))
        os.environ['PATH'] = str(dll) + os.pathsep + os.environ['PATH']
    import numpy as np
    import torch
    from faster_whisper import WhisperModel
    from huggingface_hub import snapshot_download
    started = time.monotonic()
    model_path = snapshot_download(MODEL, revision=REVISION, local_files_only=True)
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    model = WhisperModel(model_path, device=device, compute_type='int8_float16' if device == 'cuda' else 'int8', local_files_only=True)
    emit({'ready': True, 'engine': 'faster-whisper', 'model': 'large-v3-turbo', 'device': device, 'loadSeconds': round(time.monotonic()-started, 3)})
    for line in sys.stdin:
        if len(line) > 400000: raise ValueError('Speech window exceeds its bound.')
        message = json.loads(line)
        if message.get('stop'): break
        pcm = base64.b64decode(message['pcm'], validate=True)
        if not 0 < len(pcm) <= 8 * 32000 or len(pcm) % 2: raise ValueError('Invalid speech window.')
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        start = time.monotonic()
        rows = []
        # VAD plus a low energy gate avoids interpreting digital silence as words.
        if float(np.sqrt(np.mean(audio * audio))) >= 0.002:
            segments, meta = model.transcribe(audio, language=message.get('language') or None,
                beam_size=5, word_timestamps=True, vad_filter=True,
                vad_parameters={'min_silence_duration_ms': 350}, condition_on_previous_text=False)
            for segment in segments:
                if segment.no_speech_prob > 0.6 and segment.avg_logprob < -1: continue
                words = [{'start':w.start,'end':w.end,'text':w.word} for w in (segment.words or [])]
                rows.append({'start':segment.start,'end':segment.end,'text':segment.text.strip(),'words':words})
            language = meta.language
        else: language = message.get('language') or 'und'
        emit({'segments': rows, 'language': language, 'processingSeconds': round(time.monotonic()-start, 3)})


if __name__ == '__main__':
    try: main()
    except Exception as error:
        emit({'error': str(error)[-700:]})
        raise SystemExit(1)
