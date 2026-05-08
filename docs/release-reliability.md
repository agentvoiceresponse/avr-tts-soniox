# Release Reliability Runbook

This runbook defines release-time monitoring, alerting, and rollback procedures for `avr-tts-soniox`.

## 1) Ingest Freshness Alert

Goal: detect post-publish telemetry blackouts quickly.

- Alert name: `soniox_tts_no_events_post_publish`
- Trigger: no telemetry events for 30 minutes after a publish window begins
- Severity: high
- Escalation target: release engineer on-call + QA thread

Reference query (replace datasource/table names with your telemetry backend):

```sql
SELECT
  MAX(event_ts) AS last_event_ts
FROM avr_tts_soniox_events
WHERE event_ts >= NOW() - INTERVAL '30 minutes';
```

Alert condition:

- fire if `last_event_ts` is `NULL`

## 2) Telemetry Quality Gate (>=95%)

Goal: block rollouts that produce malformed telemetry.

Required fields:

- `request_id`
- `provider`
- `status_code`
- `latency_ms`
- `created_at`

Gate query:

```sql
WITH windowed AS (
  SELECT
    CASE
      WHEN request_id IS NOT NULL
       AND provider IS NOT NULL
       AND status_code IS NOT NULL
       AND latency_ms IS NOT NULL
       AND created_at IS NOT NULL
      THEN 1 ELSE 0
    END AS is_valid
  FROM avr_tts_soniox_events
  WHERE created_at >= NOW() - INTERVAL '30 minutes'
)
SELECT
  ROUND(100.0 * SUM(is_valid) / NULLIF(COUNT(*), 0), 2) AS valid_payload_pct
FROM windowed;
```

Gate policy:

- pass if `valid_payload_pct >= 95.00`
- fail and hold release if `< 95.00`

## 3) Rollback Procedure

Use this when quality gate fails or freshness alert fires.

1. Freeze rollout communication in release channel.
2. Revert deployment target to previous known-good image tag.
3. Validate service boot and readiness from reverted tag.
4. Confirm telemetry ingestion resumes and quality returns above threshold.
5. Post incident summary and next-safe redeploy window.

Rollback command template:

```bash
docker pull agentvoiceresponse/avr-tts-soniox:<previous_good_tag>
docker run --rm -p 6011:6011 -e SONIOX_API_KEY=dummy agentvoiceresponse/avr-tts-soniox:<previous_good_tag>
```

## 4) Drill Evidence (Simulated)

Drill run: `2026-05-08`

- Simulated stale-ingest condition: no synthetic events in 30m window.
- Expected result: freshness alert trigger in <20m evaluation cycle.
- Recovery simulation: restore valid events stream and re-evaluate gate.
- Expected result: alert resolved and quality gate recovers >=95%.

## 5) Release Checklist

- [x] Freshness alert rule defined (`no events for 30m post-publish`)
- [x] Telemetry quality gate documented (>=95% valid payloads)
- [x] Rollback steps documented with executable templates
- [x] Drill scenario + expected trigger/recovery outcome documented

