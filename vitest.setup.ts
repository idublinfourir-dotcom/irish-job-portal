// No test may reach the real network. Any connection to a host other than loopback or a unix socket
// throws before a packet is sent. Reach outside services through a fake instead.
import net from "node:net";

const local = new Set(["127.0.0.1", "::1", "localhost"]);
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  let host: unknown;
  // Node can pass its already-normalized arguments as one array: [options, callback]
  const a = (Array.isArray(args[0]) ? args[0][0] : args[0]) as unknown;
  if (a && typeof a === "object") {
    const o = a as { path?: string; host?: string };
    if (o.path) return connect.apply(this, args as never);
    host = o.host ?? "localhost";
  } else if (typeof a === "string") {
    return connect.apply(this, args as never); // connect(path)
  } else {
    host = typeof args[1] === "string" ? args[1] : "localhost"; // connect(port, host)
  }
  if (!local.has(String(host))) throw new Error(`Test tried to reach the real network: ${host}. Use a fake service.`);
  return connect.apply(this, args as never);
} as typeof net.Socket.prototype.connect;
