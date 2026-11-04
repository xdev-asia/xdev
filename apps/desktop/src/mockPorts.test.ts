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

test("stop removes the row and open records the id", async () => {
  const ports = createMockPorts(ROOT);
  const after = await ports.portsStop([ROOT], "localhost:5173:4101");
  expect(after.ports.map((p) => p.port)).toEqual([8080, 5432]);
  await ports.portsOpen("localhost:8080:4102");
  expect(lastOpenedPort()).toBe("localhost:8080:4102");
  const off = await ports.onPortsAdvertised(() => undefined);
  off();
});
