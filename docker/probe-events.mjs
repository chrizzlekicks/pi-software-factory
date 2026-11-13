export function decodeProbeEvent(event) {
  if (
    event?.type !== "extension_ui_request" ||
    event.method !== "notify" ||
    typeof event.message !== "string" ||
    !event.message.startsWith("pi-factory-live:")
  ) {
    return;
  }
  try {
    const probe = JSON.parse(event.message.slice("pi-factory-live:".length));
    if (probe && ["preflight", "terminal", "result", "error"].includes(probe.probe)) {
      return probe;
    }
  } catch {}
}
