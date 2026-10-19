import "../setup-home";
/**
 * openclaw resume snapshot cap wiring (工单 2/2).
 *
 * Verifies both buildResumeSnapshot call sites in the openclaw adapter
 * (before_compaction, session_end) pass RESUME_SNAPSHOT_MAX_CHARS = 12000,
 * so oversized sessions cap with ctx_search lazy-load pointers instead of
 * blowing the first-turn systemPrompt ("prompt too large", 2026-10-19).
 */

import { strict as assert } from "node:assert";
import { describe, it, vi } from "vitest";

interface RegisteredHook {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

function createMockApiHooks() {
  const typedHooks: RegisteredHook[] = [];
  const api = {
    registerHook() {},
    on(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) {
      typedHooks.push({ hookName, handler, opts });
    },
    registerContextEngine() {},
    registerCommand() {},
  };
  return { api, typedHooks };
}

// Big event (category error → buildErrorsSection emits a ctx_search pointer);
// 60k chars of data guarantees buildResumeSnapshot exceeds the 12,000 cap.
const BIG_EVENT = {
  category: "error",
  data: "x".repeat(60000),
  priority: 2,
  type: "error",
} as unknown as import("../../src/session/snapshot.js").StoredEvent;

// Small event — same category, tiny payload, stays under the cap.
const SMALL_EVENT = {
  category: "error",
  data: "x".repeat(40),
  priority: 2,
  type: "error",
} as unknown as import("../../src/session/snapshot.js").StoredEvent;

async function registerFreshPlugin() {
  vi.resetModules();
  const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
  // Import session-db through the SAME post-reset module registry so the
  // prototype spy intercepts the exact class the plugin closure uses.
  const { OpenClawSessionDB } = await import("../../src/adapters/openclaw/session-db.js");
  const { api, typedHooks } = createMockApiHooks();
  plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);
  return { typedHooks, OpenClawSessionDB };
}

describe("openclaw resume snapshot cap", () => {
  it("registers before_compaction and session_end", async () => {
    const { typedHooks } = await registerFreshPlugin();
    assert.ok(typedHooks.find(h => h.hookName === "before_compaction"), "before_compaction must be registered");
    assert.ok(typedHooks.find(h => h.hookName === "session_end"), "session_end must be registered");
  });

  it("caps oversized resume snapshots at 12000 chars with ctx_search pointers", async () => {
    const { typedHooks, OpenClawSessionDB } = await registerFreshPlugin();

    const { buildResumeSnapshot } = await import("../../src/session/snapshot.js");
    assert.ok(buildResumeSnapshot([BIG_EVENT]).length > 12000, "fixture must exceed cap");

    vi.spyOn(OpenClawSessionDB.prototype, "getEvents").mockReturnValue([BIG_EVENT] as never);

    const spy = vi.spyOn(OpenClawSessionDB.prototype, "upsertResume");

    const beforeCompaction = typedHooks.find(h => h.hookName === "before_compaction");
    assert.ok(beforeCompaction);
    await beforeCompaction.handler();

    const sessionEnd = typedHooks.find(h => h.hookName === "session_end");
    assert.ok(sessionEnd);
    await sessionEnd.handler();

    assert.equal(spy.mock.calls.length, 2, "both call sites must flush a resume snapshot");
    for (const call of spy.mock.calls) {
      const snapshot = (call as unknown[])[1] as string;
      assert.ok(snapshot.length <= 12000, `len=${snapshot.length}`);
      assert.ok(snapshot.includes("[context-mode] snapshot capped"), `len=${snapshot.length}`);
      assert.ok(snapshot.includes("ctx_search"), "must keep ctx_search lazy-load pointer");
    }
  });

  it("leaves small snapshots uncapped", async () => {
    const { typedHooks, OpenClawSessionDB } = await registerFreshPlugin();

    const { buildResumeSnapshot } = await import("../../src/session/snapshot.js");
    assert.ok(buildResumeSnapshot([SMALL_EVENT]).length < 12000, "fixture must stay under cap");

    vi.spyOn(OpenClawSessionDB.prototype, "getEvents").mockReturnValue([SMALL_EVENT] as never);

    const spy = vi.spyOn(OpenClawSessionDB.prototype, "upsertResume");

    const beforeCompaction = typedHooks.find(h => h.hookName === "before_compaction");
    assert.ok(beforeCompaction);
    await beforeCompaction.handler();

    assert.equal(spy.mock.calls.length, 1);
    const snapshot = (spy.mock.calls[0] as unknown[])[1] as string;
    assert.ok(snapshot.length > 0, "snapshot must be non-empty");
    assert.ok(!snapshot.includes("[context-mode] snapshot capped"), `len=${snapshot.length}`);
  });
});
