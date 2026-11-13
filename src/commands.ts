import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Factory } from "./controller.ts";

export function registerFactoryCommands(
  pi: ExtensionAPI,
  get: (ctx: ExtensionContext) => Promise<Factory>,
  close: () => void,
) {
  let pending: Promise<void> | undefined;
  let commandBusy = false;
  let shuttingDown = false;
  const commands = new Set<Promise<void>>();
  let current: Promise<Factory> | undefined;
  const getFactory = () => current;
  const getCommandFactory = (ctx: ExtensionContext) =>
    (current ??= get(ctx).catch((e) => {
      current = undefined;
      throw e;
    }));

  function start(f: Factory, ctx: ExtensionContext) {
    pending = f
      .drive()
      .then(() => ctx.ui.notify(f.report(), f.state.phase === "completed" ? "info" : "warning"))
      .catch((e) => ctx.ui.notify(String(e), "error"))
      .finally(() => {
        pending = undefined;
      });
  }

  pi.registerCommand("factory", {
    description:
      "Approval-gated software factory: request, approve, reject, status, inspect, pause, resume, cancel, report",
    handler: (args, ctx) => {
      if (shuttingDown) {
        ctx.ui.notify("Factory is shutting down", "warning");
        return Promise.resolve();
      }
      const command = (async () => {
        try {
          let [action = "status", ...rest] = args.trim().split(/\s+/);
          if (action === "--delivery") {
            rest.unshift(action);
            action = "request";
          }
          if (action !== "request" && rest.includes("--delivery"))
            throw new Error("Place --delivery before the request");
          const immediate = ["pause", "cancel", "status", "report", "inspect"].includes(action);
          if (commandBusy && !immediate) throw new Error("Factory command already in progress");
          if (!immediate) commandBusy = true;
          try {
            const f = await getCommandFactory(ctx);
            if (shuttingDown) throw new Error("Factory is shutting down");
            switch (action) {
              case "request": {
                const mode = rest[0] === "--delivery" ? rest.splice(0, 2)[1] : "local";
                if (rest.includes("--delivery"))
                  throw new Error("Place --delivery once before the request");
                if (mode !== "local" && mode !== "github")
                  throw new Error("Use --delivery local or github");
                await f.plan(rest.join(" "), mode);
                ctx.ui.notify(
                  `Delivery: ${mode}\nPlan awaiting approval:\n${JSON.stringify(f.state.plans.at(-1), null, 2)}`,
                  "info",
                );
                break;
              }
              case "approve":
                await f.approve();
                start(f, ctx);
                break;
              case "reject":
                f.reject();
                ctx.ui.notify("Plan rejected.", "info");
                break;
              case "pause":
                f.pause();
                ctx.ui.notify("Pause requested at the next safe boundary.", "info");
                break;
              case "resume":
                await f.resume();
                start(f, ctx);
                break;
              case "cancel":
                f.cancel();
                ctx.ui.notify(
                  "Cancellation requested; inspect the preserved artifacts.",
                  "warning",
                );
                break;
              case "inspect":
                ctx.ui.notify(JSON.stringify(f.state, null, 2), "info");
                break;
              case "status":
              case "report":
                ctx.ui.notify(f.report(), "info");
                break;
              case "recover":
                if (rest.join(" ") !== "inspected")
                  throw new Error(
                    "Use /factory recover inspected only after confirming all children stopped and inspecting the checkout",
                  );
                await f.replanAfterInterruption();
                ctx.ui.notify(
                  `Delivery: ${f.state.delivery ?? "github"}\nRecovery plan awaiting approval:\n${JSON.stringify(f.state.plans.at(-1), null, 2)}`,
                  "warning",
                );
                break;
              default:
                await f.plan(args.trim());
                ctx.ui.notify(
                  `Delivery: local\nPlan awaiting approval:\n${JSON.stringify(f.state.plans.at(-1), null, 2)}`,
                  "info",
                );
            }
          } finally {
            if (!immediate) commandBusy = false;
          }
        } catch (e) {
          ctx.ui.notify(String(e), "error");
        }
      })();
      commands.add(command);
      void command.finally(() => commands.delete(command));
      return command;
    },
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (commands.size || pending) {
      try {
        (await getFactory())?.cancel();
      } catch {}
    }
    await Promise.allSettled([...commands]);
    if (pending) await pending;
    close();
  });
}
