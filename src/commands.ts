import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Factory } from "./controller.ts";

type CommandContext = { ui: Pick<ExtensionContext["ui"], "notify"> };

export function registerFactoryCommands<C extends CommandContext>(
  pi: {
    registerCommand(
      name: string,
      options: { description: string; handler: (args: string, ctx: C) => Promise<void> },
    ): void;
    on(event: "session_shutdown", handler: () => Promise<void>): unknown;
    sendMessage?(message: { customType: string; content: string; display: boolean }): unknown;
  },
  get: (ctx: C) => Promise<Factory>,
  close: () => void,
) {
  let pending: Promise<void> | undefined;
  let commandBusy = false;
  let shuttingDown = false;
  const commands = new Set<Promise<void>>();
  let current: Promise<Factory> | undefined;
  const getFactory = () => current;
  const getCommandFactory = (ctx: C) =>
    (current ??= get(ctx).catch((e) => {
      current = undefined;
      throw e;
    }));

  function start(f: Factory, ctx: C, run: Promise<void>) {
    pending = run
      .then(() => {
        if (pi.sendMessage) {
          pi.sendMessage({ customType: "pi-factory-report", content: f.report(), display: true });
        } else {
          ctx.ui.notify(f.report(), f.state.phase === "completed" ? "info" : "warning");
        }
        return undefined;
      })
      .catch((e) => ctx.ui.notify(String(e), "error"))
      .finally(() => {
        pending = undefined;
      });
  }

  pi.registerCommand("factory", {
    description:
      "Autonomous software factory: <description>, status, pause, resume, deliver, cancel",
    handler: (args, ctx) => {
      if (shuttingDown) {
        ctx.ui.notify("Factory is shutting down", "warning");
        return Promise.resolve();
      }
      const command = (async () => {
        try {
          const action = args.trim() || "status";
          const immediate = ["pause", "cancel", "status"].includes(action);
          if ((commandBusy || pending) && !immediate) {
            throw new Error("Factory command already in progress");
          }
          if (!immediate) {
            commandBusy = true;
          }
          try {
            const f = await getCommandFactory(ctx);
            if (shuttingDown) {
              throw new Error("Factory is shutting down");
            }
            switch (action) {
              case "pause":
                f.pause();
                ctx.ui.notify("Pause requested at the next safe boundary.", "info");
                break;
              case "resume":
                await f.resume();
                start(f, ctx, f.drive());
                break;
              case "deliver":
                start(f, ctx, f.deliver());
                break;
              case "cancel":
                f.cancel();
                ctx.ui.notify(
                  "Cancellation requested; inspect the preserved artifacts.",
                  "warning",
                );
                break;
              case "status":
                ctx.ui.notify(f.report(), "info");
                break;
              default:
                start(f, ctx, f.request(args.trim()));
                ctx.ui.notify("Factory run started.", "info");
            }
          } finally {
            if (!immediate) {
              commandBusy = false;
            }
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
    await Promise.allSettled(commands);
    if (pending) {
      await pending;
    }
    close();
  });
}
