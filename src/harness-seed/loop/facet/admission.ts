/**
 * Memory admission before a round (the Midnight Apex report, recommendation 7). `worker_start`
 * checks free memory once, when the worker's window opens; a round hours later starts a build
 * and three game loads on whatever the machine has left, and a window the OS kills mid-pass
 * costs the round. A worker whose machine is short of memory waits for it at the round's
 * boundary instead, and says so once, so the director's digest can say why it is idle. A
 * capacity call that fails never holds a round: it says nothing about the machine.
 */
import { HostMethod } from "../host-methods.ts";
import { RunEvent } from "../run-events.ts";
import { SECOND_MS } from "../time.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { FacetLoop } from "./state.ts";

/** A running worker's round needs this much free memory (a new worker's window needs MIN_FREE_MB). */
export const ROUND_MIN_FREE_MB = 512;
/** How often a waiting round asks the machine again. */
export const MACHINE_PRESSURE_POLL_MS = 15 * SECOND_MS;

/** What admission reads off the loop: its host, clock, deadline and run log. */
type AdmissionLoop = Pick<FacetLoop, "appendRun" | "ctx" | "deadline" | "facet" | "run" | "sleepFor">;

/** Free memory as the host reports it, or null when it says nothing (an older host, a failed call). */
async function freeMemoryMb(ctx: AdmissionLoop["ctx"]): Promise<number | null> {
  try {
    const capacity = (await ctx.call(HostMethod.PreviewCapacity, {})) as AnyRecord | null;
    const freeMb = capacity?.memory?.freeMb;
    return typeof freeMb === "number" && Number.isFinite(freeMb) ? freeMb : null;
  } catch {
    return null;
  }
}

/** Is the machine short of memory for a round, as far as anybody can tell? */
function underPressure(freeMb: number | null): freeMb is number {
  return freeMb !== null && freeMb < ROUND_MIN_FREE_MB;
}

/** Can the facet wait one more poll and still have time left after it? */
function canWaitAnotherPoll(loop: AdmissionLoop): boolean {
  return !loop.ctx.cancelled && Date.now() + MACHINE_PRESSURE_POLL_MS < loop.deadline;
}

/**
 * Wait while the machine has less than ROUND_MIN_FREE_MB free and the facet's clock allows
 * another poll. Records one FacetMachinePressure per wait; the round's own gates (the clock, a
 * stop) decide what happens after it.
 */
export async function admitRound(loop: AdmissionLoop, iteration: number): Promise<void> {
  let freeMb = await freeMemoryMb(loop.ctx);
  if (!underPressure(freeMb) || !canWaitAnotherPoll(loop)) return;
  await loop
    .appendRun(RunEvent.FacetMachinePressure, {
      runId: loop.run.runId,
      facetId: loop.facet.id,
      iteration,
      freeMb,
      needMb: ROUND_MIN_FREE_MB,
    })
    .catch(() => {});
  while (underPressure(freeMb) && canWaitAnotherPoll(loop)) {
    await loop.sleepFor(MACHINE_PRESSURE_POLL_MS);
    freeMb = await freeMemoryMb(loop.ctx);
  }
}
