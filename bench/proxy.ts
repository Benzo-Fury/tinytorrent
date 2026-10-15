/**
 * A TCP proxy that adds latency in both directions, standing in for `tc
 * netem` where that isn't available (macOS, containers without NET_ADMIN).
 * Runs in its own process so its CPU is not charged to the engine under test.
 *
 *   bun bench/proxy.ts <listenPort> <targetHost:targetPort> <delayMs>
 *
 * Prints `ready <port>` once listening.
 */

import net from "node:net";

const [listenArg, target, delayArg] = process.argv.slice(2);
const [targetHost, targetPort] = (target ?? "").split(":");
const delay = Number(delayArg ?? 0);

/** Forwards `from` to `to`, holding each chunk for `delay` ms while keeping order. */
function pipe(from: net.Socket, to: net.Socket): void {
  from.on("data", (chunk) => {
    if (delay === 0) {
      if (!to.write(chunk)) from.pause();
      return;
    }
    setTimeout(() => {
      if (!to.destroyed && !to.write(chunk)) from.pause();
    }, delay);
  });
  to.on("drain", () => from.resume());
  from.on("close", () => setTimeout(() => to.destroy(), delay));
  from.on("error", () => to.destroy());
}

const server = net.createServer({ noDelay: true }, (client) => {
  const upstream = net.connect({ host: targetHost, port: Number(targetPort), noDelay: true });
  pipe(client, upstream);
  pipe(upstream, client);
});
server.listen(Number(listenArg ?? 0), "127.0.0.1", () => {
  const address = server.address();
  console.log(`ready ${typeof address === "object" && address ? address.port : 0}`);
});
