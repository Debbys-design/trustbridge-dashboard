# Maintainer Email Digest

The maintainer cron digest is composed in `src/lib/cron-digest.ts` and delivered
through `src/lib/email.ts`. It runs on the maintainer cron schedule and
summarizes outstanding work for maintainers.

## Sections

- **Pending payouts** — payouts awaiting maintainer action.
- **Open disputes** — disputes that are still open.
- **Dispute SLA breaches** — disputes older than the configured SLA threshold.

## Dispute SLA breaches

Disputes whose age exceeds the configured SLA are surfaced in the digest so that
stale disputes blocking Wave payouts are not missed.

Each digest includes:

- A **count** of disputes that have breached the SLA.
- **Deep links** to each breached dispute in the dashboard so maintainers can
  act directly from the email.

### PII policy

The digest does not leak PII beyond the existing masking policy. Breached
disputes are identified by their dispute reference and a deep link only; no
additional participant details are included in the email body.

## Configuration

The SLA threshold is read from the existing dispute configuration. No new
environment variables are introduced by this feature.

## Related surfaces

- `src/lib/cron-digest.ts` — digest composition.
- `src/lib/email.ts` — email rendering and delivery.
- `src/app/api/disputes/` — disputes API used to resolve deep links.
