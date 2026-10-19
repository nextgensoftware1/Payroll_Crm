/** Upload creates the device from the file itself, and refuses files that
 *  don't match the chosen device. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { parseNextBatch } from "../src/server/jobs/attendance-import.ts";
import { getBatch, listDevices, uploadBatch } from "../src/server/services/attendance.ts";
import { detectDevice } from "../src/server/zkteco/detect.ts";
import { rejects, SAMPLE, setup } from "./harness.ts";

let h: Awaited<ReturnType<typeof setup>>;
before(async () => { h = await setup(); });
after(async () => { await h.teardown(); });
const csv = (rows: string[]) => new TextEncoder().encode(["No.,Name,Date/Time,Status,Location ID", ...rows].join("\n"));

test("detects the August file's settings", () => {
  const d = detectDevice(SAMPLE);
  assert.deepEqual([d.locationCode, d.inLabel, d.outLabel, d.datetimeFormat, d.ambiguous, d.rows],
    ["101", "C/In", "C/Out", "M/D/YYYY h:mm:ss AM", false, 476]);
});

test("day-first and ISO files are recognised; ambiguous ones follow the preference", () => {
  assert.equal(detectDevice(csv(["1,A,13/08/2026 18:00:00,C/In,7"])).datetimeFormat, "D/M/YYYY H:mm:ss");
  assert.equal(detectDevice(csv(["1,A,2026-08-13 18:00:00,IN,7"])).datetimeFormat, "YYYY-MM-DD HH:mm:ss");
  const amb = detectDevice(csv(["1,A,8/5/2026 6:00:00 PM,Check In,7"]), "day_first");
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.datetimeFormat, "D/M/YYYY h:mm:ss AM");
  assert.equal(amb.inLabel, "Check In");
});

test("first upload with a new device: device created from the file, then parsed normally", async () => {
  const id = await h.as("hr", (c) => uploadBatch(c, h.storage, { newDevice: { name: "Back office" }, filename: "AUGUST_ATTANADANCE.xls", data: SAMPLE }));
  const dev = (await h.as("hr", (c) => listDevices(c))).find((d) => d.name === "Back office")!;
  assert.deepEqual([dev.location_code, dev.datetime_format, dev.status_label_map], ["101", "M/D/YYYY h:mm:ss AM", { "C/In": "in", "C/Out": "out" }]);
  await parseNextBatch(h.storage);
  const b = await h.as("hr", (c) => getBatch(c, id));
  assert.deepEqual([b.status, b.parsed_rows, b.error_rows], ["under_review", 476, 0]);
});

test("a file from a different Location ID is refused for that device", async () => {
  const dev = (await h.as("hr", (c) => listDevices(c))).find((d) => d.name === "Back office")!;
  await rejects(h.as("hr", (c) => uploadBatch(c, h.storage, { deviceId: dev.id, filename: "other.csv",
    data: csv(["5,B,8/14/2026 6:00:00 PM,C/In,202"]) })), 422, "Location ID 202");
});

test("a file whose date order contradicts the device is refused", async () => {
  const dev = (await h.as("hr", (c) => listDevices(c))).find((d) => d.name === "Back office")!;
  await rejects(h.as("hr", (c) => uploadBatch(c, h.storage, { deviceId: dev.id, filename: "dm.csv",
    data: csv(["5,B,14/08/2026 6:00:00 PM,C/In,101"]) })), 422, "dates look like");
});

test("files that aren't attendance exports are refused before anything is stored", async () => {
  await rejects(h.as("hr", (c) => uploadBatch(c, h.storage, { newDevice: { name: "X device" }, filename: "notes.csv",
    data: new TextEncoder().encode("hello,world\n1,2\n") })), 422, "can't be read");
  const [n] = await h.owner`select count(*)::int as n from hr.device where name = 'X device'`;
  assert.equal(n!.n, 0);
});

test("a new device needs a name", async () => {
  await rejects(h.as("hr", (c) => uploadBatch(c, h.storage, { newDevice: { name: " " }, filename: "a.csv",
    data: csv(["5,B,8/14/2026 6:00:00 PM,C/In,303"]) })), 422, "Name the device");
});
