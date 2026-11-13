import { strict as assert } from "node:assert";
import { test } from "node:test";

import { decodeProbeEvent } from "../docker/probe-events.mjs";

test("probe decoding accepts only tagged RPC notifications", () => {
  const message = "pi-factory-live:" + JSON.stringify({ probe: "preflight", ok: true });
  assert.deepEqual(decodeProbeEvent({ type: "extension_ui_request", method: "notify", message }), {
    probe: "preflight",
    ok: true,
  });
  assert.equal(decodeProbeEvent({ probe: "preflight", ok: true }), undefined);
  assert.equal(
    decodeProbeEvent({
      type: "extension_ui_request",
      method: "notify",
      message: '{"probe":"preflight"}',
    }),
    undefined,
  );
  assert.equal(
    decodeProbeEvent({
      type: "extension_ui_request",
      method: "notify",
      message: "pi-factory-live:{",
    }),
    undefined,
  );
  assert.equal(
    decodeProbeEvent({ type: "extension_ui_request", method: "setStatus", message }),
    undefined,
  );
});
