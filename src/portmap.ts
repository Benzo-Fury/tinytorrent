/**
 * Port mapping, so peers behind other NATs can reach us: NAT-PMP (RFC 6886;
 * routers, and VPNs such as ProtonVPN that forward a port on request) first,
 * then UPnP IGD (most home routers). Every packet and request goes through
 * the engine's transport: bound to a VPN address, the requests go into the
 * tunnel, never to the LAN router behind it.
 *
 * Mappings are renewed before their lease runs out and removed on stop. The
 * external ports found are what the engine announces.
 */

import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { EventEmitter } from "node:events";
import type { Transport } from "./transport";

/** Options for `EngineOptions.portMapping`. */
export interface PortMappingOptions {
  /** NAT-PMP gateway; by default the default route's gateway (or the bound address's `.1`). */
  gateway?: string;
  /** NAT-PMP port; 5351 unless testing. */
  natPmpPort?: number;
  /** Skip SSDP discovery and use this IGD description URL. */
  upnpLocation?: string;
  /** Where SSDP searches go; `239.255.255.250:1900` unless testing. */
  ssdpAddress?: string;
  /** Which methods to try, in order. Default both. */
  methods?: Array<"natpmp" | "upnp">;
}

/** One mapping that worked. */
export interface Mapping {
  protocol: "tcp" | "udp";
  internal: number;
  external: number;
  method: "natpmp" | "upnp";
}

const LEASE_SECONDS = 3600;
const UPNP_SERVICE = /urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d/;

export class PortMapper extends EventEmitter {
  public readonly mappings: Mapping[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private upnp: { control: string; service: string; client: string } | null = null;
  /** External ports from earlier mappings, asked for again on renewal. */
  private readonly preferred: Partial<Record<"tcp" | "udp", number>> = {};
  private stopped = false;

  constructor(
    private readonly transport: Transport,
    private readonly ports: { tcp: number; udp: number },
    private readonly options: PortMappingOptions = {},
  ) {
    super();
  }

  /** The external port for a protocol, when mapped. */
  public external(protocol: "tcp" | "udp"): number | undefined {
    return this.mappings.find((m) => m.protocol === protocol)?.external;
  }

  /** Maps both ports with the first method that works; emits `mapped` or `warning`. */
  public async start(): Promise<void> {
    const errors: string[] = [];
    for (const method of this.options.methods ?? ["natpmp", "upnp"]) {
      try {
        const lifetime = method === "natpmp" ? await this.natPmpAll() : await this.upnpAll();
        if (this.stopped) return;
        this.emit("mapped", [...this.mappings]);
        // Renew at half the lease (NAT-PMP may grant less than asked)
        this.timer = setTimeout(() => void this.renew(), Math.max(lifetime / 2, 20) * 1000);
        this.timer.unref();
        return;
      } catch (error) {
        errors.push(`${method}: ${(error as Error).message}`);
        this.mappings.length = 0;
      }
    }
    this.emit("warning", `Port mapping failed (${errors.join("; ")})`);
  }

  /** Removes the mappings. Best effort, at most 2 s. */
  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const removals = this.mappings.map((m) => (m.method === "natpmp" ? this.natPmp(m.protocol, m.internal, 0, 0) : this.upnpDelete(m)).catch(() => undefined));
    this.mappings.length = 0;
    await Promise.race([Promise.allSettled(removals), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }

  private async renew(): Promise<void> {
    const previous = this.mappings.map((m) => `${m.protocol}:${m.external}`).join();
    for (const m of this.mappings) this.preferred[m.protocol] = m.external;
    this.mappings.length = 0;
    await this.start();
    if (this.mappings.map((m) => `${m.protocol}:${m.external}`).join() !== previous) this.emit("changed");
  }

  // ---------- NAT-PMP ---------- //

  /** Maps TCP and UDP; resolves with the shorter lifetime granted. */
  private async natPmpAll(): Promise<number> {
    let lifetime = LEASE_SECONDS;
    for (const protocol of ["tcp", "udp"] as const) {
      const internal = this.ports[protocol];
      if (!internal) continue;
      // Ask for the external port we got before (or the same as internal)
      const result = await this.natPmp(protocol, internal, this.preferred[protocol] ?? internal, LEASE_SECONDS);
      this.mappings.push({ protocol, internal, external: result.external, method: "natpmp" });
      lifetime = Math.min(lifetime, result.lifetime);
    }
    return lifetime;
  }

  /** One NAT-PMP map request (lifetime 0 removes), retried at 250 ms, 500 ms, 1 s and 2 s. */
  private async natPmp(protocol: "tcp" | "udp", internal: number, external: number, lifetime: number): Promise<{ external: number; lifetime: number }> {
    const gateway = this.options.gateway ?? defaultGateway(this.transport.localAddress());
    if (!gateway) throw new Error("no gateway found");
    const port = this.options.natPmpPort ?? 5351;
    const request = Buffer.alloc(12);
    request[1] = protocol === "udp" ? 1 : 2;
    request.writeUInt16BE(internal, 4);
    request.writeUInt16BE(external, 6);
    request.writeUInt32BE(lifetime, 8);
    const socket = await this.transport.udp(0);
    let answer: ((msg: Buffer) => void) | null = null;
    socket.on("message", (msg: Buffer) => answer?.(msg));
    try {
      for (let wait = 250; wait <= 2000; wait *= 2) {
        const reply = await new Promise<Buffer | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), wait);
          answer = (msg) => {
            clearTimeout(timer);
            resolve(msg);
          };
          socket.send(request, port, gateway, (error) => error && resolve(null));
        });
        if (!reply) continue;
        if (reply.length < 16 || reply[1] !== 128 + (request[1] as number)) throw new Error("bad NAT-PMP reply");
        const code = reply.readUInt16BE(2);
        if (code !== 0) throw new Error(`NAT-PMP refused (result ${code})`);
        return { external: reply.readUInt16BE(10), lifetime: reply.readUInt32BE(12) };
      }
      throw new Error(`no answer from ${gateway}`);
    } finally {
      socket.close();
    }
  }

  // ---------- UPnP IGD ---------- //

  private async upnpAll(): Promise<number> {
    this.upnp ??= await this.discover();
    for (const protocol of ["tcp", "udp"] as const) {
      const internal = this.ports[protocol];
      if (!internal) continue;
      let external = this.preferred[protocol] ?? internal;
      let lease = LEASE_SECONDS;
      for (let attempt = 0; ; attempt++) {
        const fault = await this.upnpAdd(protocol, internal, external, lease);
        if (fault === null) break;
        // 725: only permanent leases; 718: the port is taken, try another once
        if (fault === 725 && lease) lease = 0;
        else if (fault === 718 && attempt === 0) external = 20000 + Math.floor(Math.random() * 40000);
        else throw new Error(`AddPortMapping failed (${fault})`);
      }
      this.mappings.push({ protocol, internal, external, method: "upnp" });
    }
    return LEASE_SECONDS;
  }

  /** Finds the gateway's WAN connection service: SSDP search, then its description. */
  private async discover(): Promise<{ control: string; service: string; client: string }> {
    const location = this.options.upnpLocation ?? (await this.ssdp());
    const description = await this.transport.http(location, { method: "GET", timeoutMs: 3000 });
    for (const block of description.body.split(/<service>/i).slice(1)) {
      const service = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1];
      const control = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
      if (service && control && UPNP_SERVICE.test(service)) {
        const base = /<URLBase>\s*([^<]+?)\s*<\/URLBase>/i.exec(description.body)?.[1] ?? location;
        const client = description.localAddress ?? this.transport.localAddress();
        if (!client) throw new Error("could not tell our LAN address");
        return { control: new URL(control, base).href, service, client };
      }
    }
    throw new Error("the gateway has no WAN connection service");
  }

  /** An SSDP M-SEARCH for internet gateways; resolves with the first description URL. */
  private async ssdp(): Promise<string> {
    const [host, port] = (this.options.ssdpAddress ?? "239.255.255.250:1900").split(":") as [string, string];
    const socket = await this.transport.udp(0);
    try {
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no gateway answered SSDP")), 3000);
        socket.on("message", (msg: Buffer) => {
          const location = /^location:\s*(\S+)/im.exec(msg.toString())?.[1];
          if (!location) return;
          clearTimeout(timer);
          resolve(location);
        });
        for (const target of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:service:WANIPConnection:1"]) {
          const search = `M-SEARCH * HTTP/1.1\r\nHOST: ${host}:${port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${target}\r\n\r\n`;
          socket.send(search, Number(port), host);
        }
      });
    } finally {
      socket.close();
    }
  }

  /** AddPortMapping; resolves with null on success or the UPnP error code. */
  private async upnpAdd(protocol: "tcp" | "udp", internal: number, external: number, lease: number): Promise<number | null> {
    const { client } = this.upnp as { client: string };
    return this.soap("AddPortMapping", {
      NewRemoteHost: "",
      NewExternalPort: external,
      NewProtocol: protocol.toUpperCase(),
      NewInternalPort: internal,
      NewInternalClient: client,
      NewEnabled: 1,
      NewPortMappingDescription: "tinytorrent",
      NewLeaseDuration: lease,
    });
  }

  private async upnpDelete(mapping: Mapping): Promise<void> {
    await this.soap("DeletePortMapping", { NewRemoteHost: "", NewExternalPort: mapping.external, NewProtocol: mapping.protocol.toUpperCase() });
  }

  private async soap(action: string, args: Record<string, string | number>): Promise<number | null> {
    const { control, service } = this.upnp as { control: string; service: string };
    const fields = Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join("");
    const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${fields}</u:${action}></s:Body></s:Envelope>`;
    const reply = await this.transport.http(control, {
      method: "POST",
      body,
      headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${service}#${action}"` },
      timeoutMs: 5000,
    });
    if (reply.status === 200) return null;
    return Number(/<errorCode>\s*(\d+)\s*<\/errorCode>/i.exec(reply.body)?.[1] ?? reply.status);
  }
}

/**
 * The gateway to ask for NAT-PMP: with a bound address (a VPN), `.1` of its
 * /24, where VPN gateways sit; otherwise the default route's gateway on
 * Linux, or `.1` of the first LAN address.
 */
export function defaultGateway(bound: string | undefined): string | null {
  const dotOne = (address: string): string => address.replace(/\.\d+$/, ".1");
  if (bound && /^\d+\.\d+\.\d+\.\d+$/.test(bound)) return dotOne(bound);
  try {
    for (const line of readFileSync("/proc/net/route", "utf8").split("\n").slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination !== "00000000" || !gateway) continue;
      const n = Number.parseInt(gateway, 16);
      return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join(".");
    }
  } catch {
    // Not Linux
  }
  for (const list of Object.values(networkInterfaces())) {
    const lan = list?.find((a) => a.family === "IPv4" && !a.internal);
    if (lan) return dotOne(lan.address);
  }
  return null;
}
