// Append-only proposal history: staged, revised, accepted, rejected, retired,
// rehomed. The ledger keeps only the latest state per pattern, so this is the
// only place a chart can rebuild that history from.

import { z } from "zod";
import { fsx, paths } from "@sil/core";

export const PROPOSAL_EVENT_KINDS = ["staged", "revised", "accepted", "rejected", "retired", "rehomed"] as const;
export type ProposalEventKind = (typeof PROPOSAL_EVENT_KINDS)[number];

const ProposalEventSchema = z.object({
  ts: z.string(),
  world: z.string(),
  pattern: z.string(),
  event: z.enum(PROPOSAL_EVENT_KINDS),
});
export interface ProposalEvent {
  ts: string;
  world: string;
  pattern: string;
  event: ProposalEventKind;
}

export function appendProposalEvent(world: string, pattern: string, event: ProposalEventKind): void {
  fsx.appendJsonl(paths.proposalEventsFile(), { ts: fsx.nowIso(), world, pattern, event });
}

/** appendProposalEvent runs after a commit (stage, accept, reject, rehome,
 * retire, revise) already landed. That history is for charts, not the
 * commit's own correctness: losing one event must not fail an operation the
 * repository already carried out. A write failure here logs to the
 * curriculum log and returns its message instead of throwing. */
export function recordProposalEvent(world: string, pattern: string, event: ProposalEventKind): string | null {
  try {
    appendProposalEvent(world, pattern, event);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    fsx.appendLine(paths.logFile("curriculum"), `${fsx.nowIso()} ERROR proposal event ${event} ${world}/${pattern}: ${message}`);
    return message;
  }
}

/** Every recorded event, oldest first. A line that fails to parse or match the
 * schema is data loss for one record, not for the file: it is counted in
 * `skipped`, never silently dropped from the count. */
export function readProposalEvents(): { events: ProposalEvent[]; skipped: number } {
  const path = paths.proposalEventsFile();
  if (!fsx.exists(path)) return { events: [], skipped: 0 };
  const events: ProposalEvent[] = [];
  let skipped = 0;
  for (const line of fsx.readText(path).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      events.push(ProposalEventSchema.parse(JSON.parse(t)));
    } catch {
      skipped += 1;
    }
  }
  return { events, skipped };
}
