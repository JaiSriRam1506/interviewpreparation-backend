import json
import os
import sys
import traceback


def _eprint(*args):
    print(*args, file=sys.stderr, flush=True)


def _load_model():
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        raise RuntimeError(
            "faster-whisper is not installed in the backend Python environment. "
            "Install it with: pip install faster-whisper"
        ) from e

    model_name = os.environ.get("FASTER_WHISPER_MODEL", "small")
    device = os.environ.get("FASTER_WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("FASTER_WHISPER_COMPUTE_TYPE", "int8")

    # Keep defaults tuned for latency.
    return WhisperModel(model_name, device=device, compute_type=compute_type)


def main():
    model = _load_model()

    # Read JSON lines from stdin, write JSON lines to stdout.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
            req_id = str(req.get("id", ""))
            audio_path = req.get("audioPath")
            language = req.get("language")

            condition_on_previous_text = bool(
                req.get("conditionOnPreviousText", False)
            )
            initial_prompt = req.get("initialPrompt")
            if isinstance(initial_prompt, str):
                initial_prompt = initial_prompt.strip() or None
            else:
                initial_prompt = None

            if not req_id:
                raise ValueError("Missing request id")
            if not audio_path or not isinstance(audio_path, str):
                raise ValueError("Missing audioPath")

            beam_size = int(req.get("beamSize", 1) or 1)
            vad_filter = bool(req.get("vadFilter", True))

            # VAD defaults: cut silence quickly to reduce latency.
            vad_parameters = req.get("vadParameters")
            if not isinstance(vad_parameters, dict):
                vad_parameters = {
                    "min_silence_duration_ms": 200,
                }

            # faster-whisper returns segments generator and an info object.
            segments, _info = model.transcribe(
                audio_path,
                language=language or None,
                beam_size=beam_size,
                vad_filter=vad_filter,
                vad_parameters=vad_parameters,
                temperature=0,
                best_of=1,
                condition_on_previous_text=condition_on_previous_text,
                initial_prompt=initial_prompt,
            )

            parts = []
            for seg in segments:
                text = getattr(seg, "text", None)
                if text:
                    parts.append(text)

            out = {
                "id": req_id,
                "ok": True,
                "text": "".join(parts).strip(),
            }
            print(json.dumps(out, ensure_ascii=False), flush=True)

        except Exception as e:
            req_id = ""
            try:
                req_id = str(json.loads(line).get("id", ""))
            except Exception:
                pass

            _eprint("faster_whisper_worker error:", str(e))
            _eprint(traceback.format_exc())

            out = {
                "id": req_id,
                "ok": False,
                "error": str(e) or "faster-whisper transcription failed",
            }
            print(json.dumps(out, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
