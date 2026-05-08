# Agent Voice Response - Soniox TTS Integration

[![Discord](https://img.shields.io/discord/1347239846632226998?label=Discord&logo=discord)](https://discord.gg/DFTU69Hg74)
[![GitHub Repo stars](https://img.shields.io/github/stars/agentvoiceresponse/avr-tts-soniox?style=social)](https://github.com/agentvoiceresponse/avr-tts-soniox)
[![Docker Pulls](https://img.shields.io/docker/pulls/agentvoiceresponse/avr-tts-soniox?label=Docker%20Pulls&logo=docker)](https://hub.docker.com/r/agentvoiceresponse/avr-tts-soniox)
[![Ko-fi](https://img.shields.io/badge/Support%20us%20on-Ko--fi-ff5e5b.svg)](https://ko-fi.com/agentvoiceresponse)

## Overview

This repository integrates **Agent Voice Response (AVR)** with **Soniox Real-Time TTS**.

It exposes a streaming endpoint that synthesizes low-latency speech from text and returns telephony-ready audio chunks as they are produced.

## Features

- **Low-latency synthesis**: Streams Soniox real-time TTS output over HTTP.
- **Streaming audio response**: Sends audio bytes progressively to the client.
- **Configurable request payload**: Supports per-request model, voice, language, and format.
- **Resilient streaming behavior**: Handles timeouts, disconnects, and upstream trailer errors.

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and configure:

#### Required

```dotenv
SONIOX_API_KEY=your_soniox_api_key_here
```

#### Optional

```dotenv
SONIOX_TTS_URL=https://tts-rt.soniox.com/tts
SONIOX_TTS_MODEL=tts-rt-v1
SONIOX_TTS_LANGUAGE=en
SONIOX_TTS_VOICE=Adrian
SONIOX_TTS_AUDIO_FORMAT=pcm_s16le
SONIOX_TTS_SAMPLE_RATE=8000
SONIOX_TTS_BITRATE=
SONIOX_TTS_TIMEOUT_MS=30000
PORT=6011
```

## Usage

### Start the Application

```bash
npm install
npm start
```

### API Usage

- **Endpoint:** `/text-to-speech-stream`
- **Method:** `POST`
- **Headers:**
  - `Content-Type: application/json`
  - `x-uuid` (optional): request correlation id for logs
- **Body:**
  - `text` (required): text to synthesize
  - `model` (optional): Soniox model override
  - `voice` (optional): voice override
  - `language` (optional): language override
  - `audio_format` or `audioFormat` (optional): audio format override
  - `sample_rate` or `sampleRate` (optional): sample rate override
  - `bitrate` (optional): bitrate override

#### Example Request

```bash
curl -X POST http://localhost:6011/text-to-speech-stream \
  -H "Content-Type: application/json" \
  -H "x-uuid: demo-123" \
  -d '{"text":"Hello from Soniox","voice":"Adrian","language":"en","audio_format":"pcm_s16le","sample_rate":8000}' \
  --output response.raw
```

## API Response

The endpoint streams raw audio to the client:

- **Content-Type:** `audio/l16` for PCM formats, otherwise `application/octet-stream`
- **Delivery mode:** Chunked streaming response
- **Error shape:** JSON error payloads for validation, timeout, and upstream failures

## Configuration Strategies

Parameter resolution priority:

1. **HTTP request body** (`model`, `voice`, `language`, `audio_format`, `sample_rate`, `bitrate`)
2. **Environment variables** (`SONIOX_TTS_*`)
3. **Built-in defaults** (configured in connector runtime)

## Error Handling

Expected error scenarios:

- Missing `SONIOX_API_KEY` returns `500` with configuration error details.
- Missing or invalid `text` returns `400 Bad Request`.
- Soniox upstream timeout returns deterministic `504`.
- Upstream/API/network failures return `500` or pass-through Soniox status when available.

## Docker Support

```bash
docker build -t agentvoiceresponse/avr-tts-soniox .
docker run --rm -p 6011:6011 --env-file .env agentvoiceresponse/avr-tts-soniox
```

## Support & Community

- **GitHub:** [https://github.com/agentvoiceresponse](https://github.com/agentvoiceresponse) - Report issues, contribute code.
- **Discord:** [https://discord.gg/DFTU69Hg74](https://discord.gg/DFTU69Hg74) - Join the community discussion.
- **Docker Hub:** [https://hub.docker.com/u/agentvoiceresponse](https://hub.docker.com/u/agentvoiceresponse) - Find Docker images.
- **Wiki:** [https://wiki.agentvoiceresponse.com/en/home](https://wiki.agentvoiceresponse.com/en/home) - Project documentation and guides.

## Support AVR

AVR is free and open-source.
Any support is entirely voluntary and intended as a personal gesture of appreciation.
Donations do not provide access to features, services, or special benefits, and the project remains fully available regardless of donations.

<a href="https://ko-fi.com/agentvoiceresponse" target="_blank"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support us on Ko-fi"></a>

## License

MIT License - see the [LICENSE](LICENSE.md) file for details.