import assert from "node:assert/strict";
import { test } from "node:test";
import { bus } from "../src/server/bus.js";

test("polling clients get exactly the events after the last one they saw", () => {
  const start = bus.lastSeq;
  bus.publish({ type: "prices.updated" });
  bus.publish({ type: "remote.updated" });
  const first = bus.since(start);
  assert.deepEqual(first.events.map((e) => e.type), ["prices.updated", "remote.updated"]);
  assert.equal(first.gap, false);
  assert.equal(bus.since(first.seq).events.length, 0, "nothing new");

  // A client that fell more than 5000 events behind is told to refresh.
  for (let i = 0; i < 5100; i++) bus.publish({ type: "prices.updated" });
  assert.equal(bus.since(first.seq).gap, true);
  assert.equal(bus.since(bus.lastSeq - 10).events.length, 10);
});
