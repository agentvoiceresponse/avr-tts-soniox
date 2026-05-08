# Changelog

## [1.0.2] - 2026-05-08

### Fixed
- Enforced deterministic upstream timeout abortion for Soniox requests to avoid hanging streams.
- Mapped upstream connection resets (`ECONNRESET`) to a stable `502` JSON error before headers are sent.
- Improved downstream disconnect handling to tear down upstream sockets promptly during streaming.

## [1.0.1] - 2026-05-08

### Added
- Initial Soniox TTS connector implementation with streaming `/text-to-speech-stream` endpoint
- Test coverage for trailer handling, timeout behavior, and stream backpressure listener cleanup
- Docker build and publish workflow for `agentvoiceresponse/avr-tts-soniox`
- MIT `LICENSE.md` aligned with AVR license convention

### Changed
- Updated `README.md` to match AVR connector README conventions and current endpoint behavior
