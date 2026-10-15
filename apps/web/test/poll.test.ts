import { describe, expect, test } from "bun:test";
import { finishPoll, INITIAL_FORCE_POLL_STATE, requestPoll } from "../src/lib/poll.ts";

describe("requestPoll", () => {
  test("runs immediately when nothing is in flight", () => {
    const { run, next } = requestPoll(INITIAL_FORCE_POLL_STATE, false);
    expect(run).toBe(true);
    expect(next).toEqual({ busy: true, queuedForce: false });
  });

  test("an unforced call while busy is skipped and drops nothing", () => {
    const { run, next } = requestPoll({ busy: true, queuedForce: false }, false);
    expect(run).toBe(false);
    expect(next).toEqual({ busy: true, queuedForce: false });
  });

  // The bug: a forced call (a world switch, or an action that bumped
  // statusSeq) arriving while a poll is in flight must not be dropped.
  test("a forced call while busy is queued, not dropped", () => {
    const { run, next } = requestPoll({ busy: true, queuedForce: false }, true);
    expect(run).toBe(false);
    expect(next).toEqual({ busy: true, queuedForce: true });
  });

  test("a second forced call while already queued stays queued", () => {
    const { run, next } = requestPoll({ busy: true, queuedForce: true }, true);
    expect(run).toBe(false);
    expect(next).toEqual({ busy: true, queuedForce: true });
  });

  test("an unforced call while a force is already queued does not clear the queue", () => {
    const { run, next } = requestPoll({ busy: true, queuedForce: true }, false);
    expect(run).toBe(false);
    expect(next).toEqual({ busy: true, queuedForce: true });
  });
});

describe("finishPoll", () => {
  test("no rerun when nothing queued", () => {
    const { rerun, next } = finishPoll({ busy: true, queuedForce: false });
    expect(rerun).toBe(false);
    expect(next).toEqual({ busy: false, queuedForce: false });
  });

  test("reruns and clears the queue when a force was queued", () => {
    const { rerun, next } = finishPoll({ busy: true, queuedForce: true });
    expect(rerun).toBe(true);
    expect(next).toEqual({ busy: false, queuedForce: false });
  });
});

describe("requestPoll and finishPoll together", () => {
  test("a forced request during a busy poll runs exactly once more after it finishes", () => {
    // Simulates: tick starts an unforced poll, an accept bumps statusSeq
    // (forced) while it is still running, then the first poll finishes.
    let state = INITIAL_FORCE_POLL_STATE;
    const first = requestPoll(state, false);
    expect(first.run).toBe(true);
    state = first.next;

    const second = requestPoll(state, true);
    expect(second.run).toBe(false); // not dropped silently: queued instead
    state = second.next;

    const done = finishPoll(state);
    expect(done.rerun).toBe(true);
    state = done.next;

    const third = requestPoll(state, true);
    expect(third.run).toBe(true);
  });
});
