from pathlib import Path
import librosa
import numpy as 
from voice_engine import generate_audio

import soundfile as sf
from kokoro import KPipeline

ROOT_DIR = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT_DIR / "output" / "ultron_voice.wav"

def main() -> None:
    text=(
        "Todos os sistemas funcionando normalmente. " 
        "Como posso ajudá-lo?"
        )
    output_file = generate_audio(text)

if __name__ == "__main__":
    main()