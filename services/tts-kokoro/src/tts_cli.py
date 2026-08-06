import argparse 
from pathlib import Path
from voice_engine import generate_audio

def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Gera a voz do Ultron")

    parser.add_argument(
        "--text",
        required=True,
        help="Texto que será convertido em áudio"
    )

    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Caminho do arquivo de áudio gerado"
    )

    return parser.parse_args()

def main() -> None:
    args = parse_arguments()

    output_file = generate_audio(
        text = args.text,
        output_file=args.output,
    )

    print(
        f"AUDIO_READY:{output_file.resolve()}",
        flush=True,
    )

if __name__ == "__main__":
    main()