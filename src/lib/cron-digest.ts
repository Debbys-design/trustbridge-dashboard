import "server-only";

import { recordAuditLog } from "@/lib/audit";
import { buildDigestEmailBody, sendEmailNotification } from "@/lib/email";
import { StructuredLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { toContributorRow } from "@/lib/registrations";
import type { ContributorRow } from "@/types";

const logger = new StructuredLogger("cron-digest");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DigestCadence = "daily" | "weekly";
export type DigestStatus = "ok" | "error" | "skipped";

export interface NotReadyEntry {
  githubUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
}

export interface SlaBreachEntry {
  disputeId: string;
  /** Deep link to the dispute detail page (no PII beyond the id). */
  url: string;
  ageHours: number;
}

export interface DigestResult {
  status: DigestStatus;
  startedAt: string;
  durationMs: number;
  cadence?: DigestCadence;
  totalContributors?: number;
  readyCount?: number;
  lowReserveCount?: number;
  notReadyCount?: number;
  /** Set when DIGEST_INCLUDE_FULL_LIST=true */
  notReadyList?: NotReadyEntry[];
  /** Count of disputes older than the configured SLA threshold. */
  slaBreachCount?: number;
  /** Set when DIGEST_INCLUDE_FULL_LIST=true */
  slaBreachList?: SlaBreachEntry[];
  destination?: string;
  emailSent?: boolean;
  error?: string;
}

export interface RunDigestOptions {
  actorId?: string | null;
  actorLogin?: string | null;
  /** Override destination email (default: DIGEST_EMAIL → TREASURY_EXPORT_EMAIL) */
  destinationEmail?: string;
  /** Override cadence label for the subject line (default: resolved from env) */
  cadence?: DigestCadence;
  /** Bypass the min-interval rate gate (useful for manual triggers) */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Minimum milliseconds between digest runs. Defaults to 1 hour so that a
 * misconfigured Vercel Cron that fires every minute cannot spam the inbox.
 */
function getMinIntervalMs(): number {
  const parsed = Number.parseInt(
    process.env.DIGEST_CRON_MIN_INTERVAL_MS ?? "3600000",
    10
  );
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_600_000;
}

/**
 * Digest destination email. Falls back to the treasury export email so teams
 * only have to configure one destination for both exports and digests.
 */
export function getDigestDestinationEmail(): string {
  return (
    process.env.DIGEST_EMAIL?.trim() ||
    process.env.TREASURY_EXPORT_EMAIL?.trim() ||
    process.env.CRON_EXPORT_EMAIL?.trim() ||
    ""
  );
}

/**
 * Resolve the configured cadence label from `DIGEST_CADENCE`.
 * Anything other than "weekly" is treated as "daily" (fail-safe default).
 */
export function getConfiguredCadence(): DigestCadence {
  const raw = process.env.DIGEST_CADENCE?.trim().toLowerCase();
  return raw === "weekly" ? "weekly" : "daily";
}

/**
 * Whether the full per-contributor list should be included in the digest.
 * Default: false (counts + dashboard link only).
 * Enable with DIGEST_INCLUDE_FULL_LIST=true.
 */
export function isFullListEnabled(): boolean {
  const raw = process.env.DIGEST_INCLUDE_FULL_LIST?.trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

/**
 * Dispute SLA threshold in hours. Disputes older than this are flagged as
 * SLA breaches in the digest. Defaults to 72 hours.
 */
export function getDisputeSlaHours(): number {
  const parsed = Number.parseInt(process.env.DISPUTE_SLA_HOURS ?? "72", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 72;
}

/**
 * Base URL used to build deep links in the digest. Falls back to the
 * configured app URL, then to a relative path so links never leak hosts.
 */
function getAppBaseUrl(): string {
  const raw =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_URL?.trim() ||
    "";
  return raw.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// Rate gate (in-process; mirrors cron-export.ts)
// ---------------------------------------------------------------------------

let lastRunAt: number | null = null;
let lastResult: DigestResult | null = null;

/** Return the last digest run result for the health/status endpoint. */
export function getLastDigestHealth(): DigestResult | null {
  return lastResult;
}

/** Reset in-process state. For testing only. */
export function resetDigestState(): void {
  lastRunAt = null;
  lastResult = null;
}

// ---------------------------------------------------------------------------
// Not-ready reason resolver
// ---------------------------------------------------------------------------

function resolveReason(
  c: ContributorRow
): "unfunded" | "no_trustline" | "low_reserve" {
  if (c.readiness === "low_reserve") return "low_reserve";
  if (!c.funded) return "unfunded";
  return "no_trustline";
}

// ---------------------------------------------------------------------------
// SLA breach detection
// ---------------------------------------------------------------------------

/**
 * Find disputes that have exceeded the configured SLA threshold.
 *
 * Only open disputes (not resolved/dismissed) are considered. Returns a
 * count plus, when the full list is enabled, deep links keyed by dispute id
 * so no contributor PII is leaked beyond the existing masking policy.
 */
export async function findDisputeSlaBreaches(
  now: number = Date.now(),
  includeFullList: boolean = isFullListEnabled()
): Promise<{ count: number; list: SlaBreachEntry[] }> {
  const slaHours = getDisputeSlaHours();
  const cutoff = new Date(now - slaHours * 60 * 60 * 1000);
  const baseUrl = getAppBaseUrl();

  const disputes = await prisma.dispute.findMany({
    where: {
      status: { in: ["open", "under_review"] },
      createdAt: { lt: cutoff },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const list: SlaBreachEntry[] = includeFullList
    ? disputes.map((d) => ({
        disputeId: d.id,
        url: `${baseUrl}/disputes/${d.id}`,
        ageHours: Math.floor(
          (now - new Date(d.createdAt).getTime()) / (60 * 60 * 1000)
        ),
      }))
    : [];

  return { count: disputes.length, list };
}

// ---------------------------------------------------------------------------
// Core digest runner
// ---------------------------------------------------------------------------

/**
 * Run the contributor not-ready digest.
 *
 * Privacy default: sends counts + dashboard link only.
 * Opt-in: set `DIGEST_INCLUDE_FULL_LIST=true` to include per-contributor
 * GitHub usernames and block reasons in the email body.
 *
 * Never throws — all errors are caught, audited, and returned as
 * `{ status: "error" }` so cron schedulers don't enter retry storms.
 */
export async function runCronDigest(
  options: RunDigestOptions = {}
): Promise<DigestResult> {
  const now = Date.now();
  const minIntervalMs = getMinIntervalMs();

  // ── Rate gate ─────────────────────────────────────────────────────────────
  if (!options.force && lastRunAt !== null && now - lastRunAt < minIntervalMs) {
    logger.info("cron_digest_skipped_rate_limited", {
      msSinceLastRun: now - lastRunAt,
      minIntervalMs,
    });
    return {
      status: "skipped",
      startedAt: new Date(now).toISOString(),
      durationMs: 0,
      error: `Rate limited: minimum interval between digests is ${minIntervalMs}ms`,
    };
  }

  lastRunAt = now;
  const startedAt = new Date(now).toISOString();
  const cadence = options.cadence ?? getConfiguredCadence();
  const includeFullList = isFullListEnabled();

  logger.info("cron_digest_started", { startedAt, cadence, includeFullList });

  try {
    // ── Fetch all active registrations ───────────────────────────────────────
    const registrations = await prisma.registration.findMany({
      where: { deletedAt: null },
      include: {
        user: {
          select: { githubUsername: true },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    const contributors: ContributorRow[] = registrations.map(toContributorRow);
    const totalContributors = contributors.length;

    // ── Tally readiness ───────────────────────────────────────────────────────
    let readyCount = 0;
    let lowReserveCount = 0;
    let notReadyCount = 0;

    const notReadyList: NotReadyEntry[] = [];

    for (const c of contributors) {
      if (c.readiness === "ready") {
        readyCount++;
      } else if (c.readiness === "low_reserve") {
        lowReserveCount++;
        notReadyCount++;
        if (includeFullList) {
          notReadyList.push({
            githubUsername: c.githubUsername,
            reason: "low_reserve",
          });
        }
      } else {
        notReadyCount++;
        if (includeFullList) {
          notReadyList.push({
            githubUsername: c.githubUsername,
            reason: resolveReason(c),
          });
        }
      }
    }

    // ── Dispute SLA breaches ─────────────────────────────────────────────────
    const slaBreaches = await findDisputeSlaBreaches(now, includeFullList);

    // ── Email ─────────────────────────────────────────────────────────────────
    const destination =
      options.destinationEmail?.trim() || getDigestDestinationEmail();

    let emailSent = false;

    if (destination) {
      const emailBody = buildDigestEmailBody({
        cadence,
        totalContributors,
        readyCount,
        lowReserveCount,
        notReadyCount,
        notReadyList: includeFullList ? notReadyList : undefined,
        slaBreachCount: slaBreaches.count,
        slaBreachList: includeFullList ? slaBreaches.list : undefined,
        generatedAt: startedAt,
      });

      const cadenceLabel = cadence === "weekly" ? "Weekly" : "Daily";
      emailSent = await sendEmailNotification({
        to: destination,
        subject: `[TrustBridge] ${cadenceLabel} Not-Ready Contributor Digest`,
        body: emailBody,
      });

      if (!emailSent) {
        logger.warn("cron_digest_email_failed", { destination });
      }
    } else {
      logger.info("cron_digest_no_destination_configured", {
        totalContributors,
        notReadyCount,
        slaBreachCount: slaBreaches.count,
      });
    }

    const durationMs = Date.now() - now;

    await recordAuditLog({
      action: "digest.cron",
      actorId: options.actorId ?? null,
      metadata: {
        cadence,
        totalContributors,
        notReadyCount,
        slaBreachCount: slaBreaches.count,
        emailSent,
      },
    });

    const result: DigestResult = {
      status: "ok",
      startedAt,
      durationMs,
      cadence,
      totalContributors,
      readyCount,
      lowReserveCount,
      notReadyCount,
      notReadyList: includeFullList ? notReadyList : undefined,
      slaBreachCount: slaBreaches.count,
      slaBreachList: includeFullList ? slaBreaches.list : undefined,
      destination: destination || undefined,
      emailSent,
    };

    lastResult = result;
    logger.info("cron_digest_completed", {
      durationMs,
      notReadyCount,
      slaBreachCount: slaBreaches.count,
      emailSent,
    });

    return result;
  } catch (err) {
    const durationMs = Date.now() - now;
    const message = err instanceof Error ? err.message : String(err);

    logger.error("cron_digest_failed", { error: message, durationMs });

    await recordAuditLog({
      action: "digest.cron",
      actorId: options.actorId ?? null,
      metadata: { error: message },
    }).catch(() => undefined);

    const result: DigestResult = {
      status: "error",
      startedAt,
      durationMs,
      cadence,
      error: message,
    };

    lastResult = result;
    return result;
  }
}
