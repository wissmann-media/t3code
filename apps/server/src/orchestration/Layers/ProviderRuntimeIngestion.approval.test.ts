import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

describe("runtimeEventToActivities approval details", () => {
  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("projects provider-specific permissions as actionable tool approvals", () => {
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-tool-request-opened"),
      provider: ProviderDriverKind.make("opencode"),
      createdAt: "2026-08-04T15:10:46.305Z",
      threadId: ThreadId.make("thread-up45"),
      requestId: RuntimeRequestId.make("per-plan-governance"),
      payload: {
        requestType: "unknown",
        detail: "plan-governance",
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.summary).toBe("Tool approval requested");
    expect(activity?.payload).toMatchObject({
      requestId: "per-plan-governance",
      requestKind: "tool",
      requestType: "unknown",
      detail: "plan-governance",
    });
  });
});
