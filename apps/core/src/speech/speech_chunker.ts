export class SpeechChunker {
    private buffer = "";

    constructor(
        private readonly minChars = 35,
        private readonly maxChars = 160,
    ) {}

    push(text: string): string[] {
        this.buffer += text;

        const chunks: string[] = [];

        while (true) {
            const boundary =
                this.findNaturalBoundary();

            if (boundary !== -1) {
                const chunk = this.buffer
                    .slice(0, boundary + 1)
                    .trim();

                this.buffer = this.buffer
                    .slice(boundary + 1)
                    .trimStart();

                if (chunk) {
                    chunks.push(chunk);
                }

                continue;
            }

            if (
                this.buffer.length >=
                this.maxChars
            ) {
                const splitAt =
                    this.findForcedBoundary();

                const chunk = this.buffer
                    .slice(0, splitAt)
                    .trim();

                this.buffer = this.buffer
                    .slice(splitAt)
                    .trimStart();

                if (chunk) {
                    chunks.push(chunk);
                }

                continue;
            }

            break;
        }

        return chunks;
    }

    flush(): string[] {
        const remaining =
            this.buffer.trim();

        this.buffer = "";

        return remaining
            ? [remaining]
            : [];
    }

    private findNaturalBoundary(): number {
        for (
            let index = this.minChars;
            index < this.buffer.length;
            index++
        ) {
            const character =
                this.buffer[index];

            if (
                character === "." ||
                character === "!" ||
                character === "?" ||
                character === ";" ||
                character === "\n"
            ) {
                return index;
            }
        }

        return -1;
    }

    private findForcedBoundary(): number {
        const searchArea =
            this.buffer.slice(
                0,
                this.maxChars,
            );

        const lastSpace =
            searchArea.lastIndexOf(" ");

        if (
            lastSpace >
            this.minChars
        ) {
            return lastSpace;
        }

        return this.maxChars;
    }
}
