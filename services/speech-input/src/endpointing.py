from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class EndpointingConfig:
    block_seconds: float = 0.05
    minimum_silence_seconds: float = 0.28
    target_silence_seconds: float = 0.32
    maximum_silence_seconds: float = 0.40
    short_utterance_seconds: float = 1.50
    long_utterance_seconds: float = 6.00
    internal_pause_seconds: float = 0.10
    pause_extension_seconds: float = 0.05
    long_utterance_extension_seconds: float = 0.03

    def __post_init__(self) -> None:
        if self.block_seconds <= 0:
            raise ValueError("block_seconds must be positive")
        if not (
            0 < self.minimum_silence_seconds
            <= self.target_silence_seconds
            <= self.maximum_silence_seconds
        ):
            raise ValueError(
                "endpoint silence must satisfy 0 < minimum <= target <= maximum"
            )
        if self.internal_pause_seconds < self.block_seconds:
            raise ValueError("internal_pause_seconds must be at least one block")


@dataclass(frozen=True)
class EndpointDecision:
    finished: bool
    trailing_silence_seconds: float
    required_silence_seconds: float
    voiced_seconds: float
    pause_count: int


class AdaptiveEndpoint:
    """Pure block-based endpoint detector, independent from audio hardware."""

    def __init__(self, config: EndpointingConfig) -> None:
        self.config = config
        self.reset()

    def reset(self) -> None:
        self.voiced_seconds = 0.0
        self.trailing_silence_seconds = 0.0
        self.pause_count = 0

    def observe(self, is_speech: bool) -> EndpointDecision:
        if is_speech:
            if (
                self.voiced_seconds > 0
                and self.trailing_silence_seconds
                + 1e-9
                >= self.config.internal_pause_seconds
            ):
                self.pause_count += 1
            self.voiced_seconds += self.config.block_seconds
            self.trailing_silence_seconds = 0.0
        elif self.voiced_seconds > 0:
            self.trailing_silence_seconds += self.config.block_seconds

        required = self.required_silence_seconds()
        return EndpointDecision(
            finished=(
                self.voiced_seconds > 0
                and self.trailing_silence_seconds + 1e-9 >= required
            ),
            trailing_silence_seconds=self.trailing_silence_seconds,
            required_silence_seconds=required,
            voiced_seconds=self.voiced_seconds,
            pause_count=self.pause_count,
        )

    def required_silence_seconds(self) -> float:
        if self.voiced_seconds <= self.config.short_utterance_seconds:
            required = self.config.minimum_silence_seconds
        else:
            required = self.config.target_silence_seconds

        if self.voiced_seconds >= self.config.long_utterance_seconds:
            required += self.config.long_utterance_extension_seconds
        if self.pause_count > 0:
            required += self.config.pause_extension_seconds

        return min(
            self.config.maximum_silence_seconds,
            max(self.config.minimum_silence_seconds, required),
        )
