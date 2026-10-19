import { strict as assert } from "node:assert";
import { describe, test, vi } from "vitest";
import {
  buildResumeSnapshot,
  type StoredEvent,
} from "../../src/session/snapshot.js";

// ── Helpers ──
function makeEvent(overrides: Partial<StoredEvent> & Pick<StoredEvent, "type" | "category">): StoredEvent {
  return {
    type: overrides.type,
    category: overrides.category,
    data: overrides.data ?? "",
    priority: overrides.priority ?? 2,
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

// Fixture covering every section that asserts on "all section names present".
function makeSectionFixture(): StoredEvent[] {
  return [
    makeEvent({ type: "file_edit", category: "file", data: "src/server.ts", priority: 1 }),
    makeEvent({ type: "error_tool", category: "error", data: "Push rejected: non-fast-forward", priority: 2 }),
    makeEvent({ type: "decision", category: "decision", data: "use ctx- prefix", priority: 2 }),
    makeEvent({ type: "rule", category: "rule", data: "CLAUDE.md: git rules", priority: 1 }),
    makeEvent({ type: "git", category: "git", data: "commit: feat: add feature", priority: 2 }),
    makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: "Implement feature" }), priority: 1 }),
    makeEvent({ type: "cwd", category: "cwd", data: "/project", priority: 2 }),
    makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }),
  ];
}

// Huge error payload — the first-turn overflow culprit (>= 50000 chars).
const ERROR_BLOB = "ERRORBLOB_START_" + "X".repeat(50000) + "_ERRORBLOB_END";
// Special marker placed in the LAST rule event so it lands in the section
// tail (< 700 chars from the section end) and must survive capping.
const CANARY = "CANARY_KEEP_ME";

// >= 300 events: the giant blob plus plenty of ordinary events.
function makeBigFixture(): StoredEvent[] {
  const events: StoredEvent[] = [];
  events.push(makeEvent({ type: "error_tool", category: "error", data: ERROR_BLOB, priority: 2 }));
  for (let i = 0; i < 120; i++) {
    events.push(makeEvent({ type: "file_edit", category: "file", data: `src/module-${i}/file-${i}.ts`, priority: 1 }));
  }
  for (let i = 0; i < 60; i++) {
    events.push(makeEvent({ type: "task", category: "task", data: JSON.stringify({ subject: `Task ${i}: implement slice ${i}` }), priority: 1 }));
  }
  for (let i = 0; i < 40; i++) {
    events.push(makeEvent({ type: "error_tool", category: "error", data: `Error ${i}: minor failure ${i}`, priority: 2 }));
  }
  for (let i = 0; i < 30; i++) {
    events.push(makeEvent({ type: "decision", category: "decision", data: `Decision ${i}: use approach ${i}`, priority: 2 }));
  }
  for (let i = 0; i < 29; i++) {
    events.push(makeEvent({ type: "rule", category: "rule", data: `Rule ${i}: constraint ${i}`, priority: 1 }));
  }
  events.push(makeEvent({ type: "rule", category: "rule", data: `Rule final: ${CANARY} marker`, priority: 1 }));
  for (let i = 0; i < 20; i++) {
    events.push(makeEvent({ type: "git", category: "git", data: `commit: change ${i}`, priority: 2 }));
  }
  events.push(makeEvent({ type: "intent", category: "intent", data: "implement", priority: 4 }));
  return events; // 1 + 120 + 60 + 40 + 30 + 30 + 20 + 1 = 302 events
}

// ════════════════════════════════════════════
// CASE 1: No maxBytes -> behavior unchanged, every section present
// ════════════════════════════════════════════

describe("maxBytes: uncapped behavior", () => {
  test("no maxBytes keeps full snapshot with every section intact", () => {
    const xml = buildResumeSnapshot(makeSectionFixture());
    assert.ok(xml.startsWith("<session_resume"), "should start with <session_resume");
    assert.ok(xml.endsWith("</session_resume>"), "should end with </session_resume>");
    assert.ok(xml.includes("<how_to_search>"), "has how_to_search");
    assert.ok(xml.includes("<files"), "has files");
    assert.ok(xml.includes("<errors"), "has errors");
    assert.ok(xml.includes("<decisions"), "has decisions");
    assert.ok(xml.includes("<rules"), "has rules");
    assert.ok(xml.includes("<git"), "has git");
    assert.ok(xml.includes("<task_state"), "has task_state");
    assert.ok(xml.includes("<environment>"), "has environment");
    assert.ok(xml.includes("<intent"), "has intent");
  });
});

// ════════════════════════════════════════════
// CASE 2 + 5: Budget enforcement, and non-positive budgets return ""
// ════════════════════════════════════════════

describe("maxBytes: budget enforcement", () => {
  test("big fixture with maxBytes=12000 stays within budget", () => {
    const events = makeBigFixture();
    assert.ok(events.length >= 300, `fixture must have >= 300 events, got ${events.length}`);
    assert.ok(ERROR_BLOB.length >= 50000, "error payload must be >= 50000 chars");

    const out = buildResumeSnapshot(events, { maxBytes: 12000 });
    assert.ok(out.length <= 12000, `capped output must be <= 12000 chars, got ${out.length}`);
  });

  test("maxBytes=0 and negative maxBytes return empty string", () => {
    assert.equal(buildResumeSnapshot(makeSectionFixture(), { maxBytes: 0 }), "");
    assert.equal(buildResumeSnapshot(makeSectionFixture(), { maxBytes: -5 }), "");
  });
});

// ════════════════════════════════════════════
// CASE 3: Lazy-load pointers survive capping
// ════════════════════════════════════════════

describe("maxBytes: lazy-load pointers", () => {
  test("capped output keeps lazy-load search pointers alive", () => {
    const events = makeBigFixture();
    const out = buildResumeSnapshot(events, { maxBytes: 12000 });

    const toolMentions = (out.match(/ctx_search/g) ?? []).length;
    assert.ok(toolMentions >= 1, `ctx_search must appear at least once, got ${toolMentions}`);

    // At least one runnable tool-call pointer block must survive
    assert.ok(out.includes('source: "session-events"'), "a lazy-load tool call block must survive");

    // Custom searchTool name replaces ctx_search everywhere, note included
    const custom = buildResumeSnapshot(events, { maxBytes: 12000, searchTool: "my_lookup" });
    assert.ok(custom.includes("my_lookup"), "custom searchTool name must appear in capped output");
  });
});

// ════════════════════════════════════════════
// CASE 4: Generous maxBytes is a byte-identical no-op
// ════════════════════════════════════════════

describe("maxBytes: identity", () => {
  test("maxBytes larger than output returns byte-identical output", () => {
    // Freeze time so generated_at cannot differ between the two builds.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    try {
      const events = makeSectionFixture();
      const full = buildResumeSnapshot(events);
      const capped = buildResumeSnapshot(events, { maxBytes: full.length + 10000 });
      assert.equal(capped, full, "output with generous maxBytes must be byte-identical");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ════════════════════════════════════════════
// CASE 6: Capping note is present
// ════════════════════════════════════════════

describe("maxBytes: capping note", () => {
  test("capped output carries the [context-mode] snapshot capped note", () => {
    const out = buildResumeSnapshot(makeBigFixture(), { maxBytes: 12000 });
    assert.ok(
      out.includes("[context-mode] snapshot capped"),
      "capped output must carry the capping note marker",
    );
  });
});

// ════════════════════════════════════════════
// CASE 7: Double canary — blob dropped whole, section-tail marker kept
// ════════════════════════════════════════════

describe("maxBytes: canaries", () => {
  test("capped output drops the giant error blob but keeps the section-tail canary", () => {
    const events = makeBigFixture();
    const full = buildResumeSnapshot(events);
    assert.ok(full.includes(ERROR_BLOB), "uncapped output must carry the full blob (precondition)");

    const out = buildResumeSnapshot(events, { maxBytes: 12000 });

    // Negative canary: the 50000-char error blob must not appear whole
    assert.ok(!out.includes(ERROR_BLOB), "full error blob must NOT survive capping");

    // Positive canary: marker within the section tail 700 chars must survive
    assert.ok(full.includes(CANARY), "uncapped output must carry the canary (precondition)");
    assert.ok(out.includes(CANARY), "CANARY_KEEP_ME in the rule section tail must survive capping");
  });
});
