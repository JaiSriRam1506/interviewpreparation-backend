import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--scorer", required=False)
    args = parser.parse_args()

    try:
        import deepspeech  # type: ignore
    except Exception as e:
        sys.stderr.write(
            "Missing Python package 'deepspeech'. Install it in your Python env (pip install deepspeech).\n"
        )
        sys.stderr.write(str(e) + "\n")
        sys.exit(2)

    try:
        import wave
    except Exception as e:
        sys.stderr.write("Missing Python stdlib wave?\n")
        sys.stderr.write(str(e) + "\n")
        sys.exit(2)

    ds = deepspeech.Model(args.model)
    if args.scorer:
        ds.enableExternalScorer(args.scorer)

    with wave.open(args.audio, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != 16000:
            sys.stderr.write(
                "Audio must be 16kHz mono 16-bit PCM WAV. Convert before using DeepSpeech.\n"
            )
            sys.exit(3)
        frames = w.getnframes()
        buffer = w.readframes(frames)

    text = ds.stt(buffer)
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
