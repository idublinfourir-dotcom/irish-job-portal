import net from "node:net";
import { describe, expect, it } from "vitest";

describe("network guard (vitest.setup.ts)", () => {
  it("refuses a connection to example.com before sending anything", () => {
    expect(() => net.connect(80, "example.com")).toThrow(/example\.com/);
    expect(() => net.connect({ host: "example.com", port: 443 })).toThrow(/real network/);
  });

  it("refuses a name that only starts like a local one", () => {
    expect(() => net.connect(80, "localhost.example.com")).toThrow(/localhost\.example\.com/);
  });

  it("allows loopback, such as the test database", async () => {
    const server = net.createServer((s) => s.end()).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as net.AddressInfo;
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    socket.destroy();
    server.close();
  });
});
