from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT_DIR / "output" / "ultron_voice.wav"

def main() -> None:
    # Manual voice probe only. Importing this module during test discovery must
    # not load Kokoro, download weights or touch an audio device.
    from voice_engine import generate_audio
    text=(
        "Todos os sistemas funcionando normalmente. " 
        "Como posso ajudá-lo?"
        )
    output_file = generate_audio(text)

if __name__ == "__main__":
    main()
