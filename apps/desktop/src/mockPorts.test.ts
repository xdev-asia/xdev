import { expect, test } from "vitest";
import { createMockPorts, lastOpenedPort } from "./mockPorts";

const ROOT = "/demo/xdev-handbook";

test("the demo scan lists a workspace, a container and an external port", async () => {
  const scan = await createMockPorts(ROOT).portsScan([ROOT], false);
  expect(scan.unavailable).toBeNull();
  expect(scan.ports.map((p) => [p.port, p.processName, p.kind])).toEqual([
    [5173, "node", "workspace"],
    [8080, "java", "container"],
    [5432, "postgres", "external"],
  ]);
  const dev = scan.ports[0]!;
  expect(dev).toMatchObject({ evidence: "terminal", advertised: true, url: "http://localhost:5173", worktree: ROOT });
});

test("stop needs a confirmation, and a second one for a port no xDev terminal started", async () => {
  const ports = createMockPorts(ROOT);
  await expect(ports.portsStop([ROOT], "localhost:5173:4101", { confirmed: false, outsideTerminal: false })).rejects.toMatchObject({ code: "port_stop_unconfirmed" });
  await expect(ports.portsStop([ROOT], "localhost:8080:4102", { confirmed: true, outsideTerminal: false })).rejects.toMatchObject({ code: "port_not_started_by_app" });
  const after = await ports.portsStop([ROOT], "localhost:8080:4102", { confirmed: true, outsideTerminal: true });
  expect(after.ports.map((p) => p.port)).toEqual([5173, 5432]);
});

test("stop removes the row and open records the id", async () => {
  const ports = createMockPorts(ROOT);
  const after = await ports.portsStop([ROOT], "localhost:5173:4101", { confirmed: true, outsideTerminal: false });
  expect(after.ports.map((p) => p.port)).toEqual([8080, 5432]);
  await ports.portsOpen("localhost:8080:4102");
  expect(lastOpenedPort()).toBe("localhost:8080:4102");
  const off = await ports.onPortsAdvertised(() => undefined);
  off();
});
