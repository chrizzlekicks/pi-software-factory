import { spawn } from "node:child_process";

import type { Run } from "./state.ts";

export function bergerDisplay() {
  let previous = "";
  return (s: Pick<Run, "phase" | "paused" | "cancelled">) => {
    const event =
      s.cancelled || s.phase === "blocked" || s.phase === "failed"
        ? "agent_settled:error"
        : s.phase === "completed"
          ? "agent_settled"
          : s.phase === "awaiting_approval" || s.paused
            ? "ui_prompt_start"
            : "agent_start";
    if (event === previous) {
      return;
    }
    previous = event;
    try {
      const child = spawn("berger", ["event"], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {});
      child.stdin.on("error", () => {});
      child.stdin.end(
        JSON.stringify({
          harness: "pi",
          hook_event_name: event.split(":")[0],
          ...(event.endsWith(":error") ? { is_error: true } : {}),
        }),
      );
    } catch {}
  };
}
