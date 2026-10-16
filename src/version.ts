/**
 * How the engine names itself to peers, derived from the package version so
 * a release only has to bump `package.json`.
 */

import pkg from "../package.json" with { type: "json" };

/** The package version, e.g. `1.0.0`. */
export const VERSION: string = pkg.version;

/** Our name in extended handshakes, e.g. `tinytorrent 1.0.0`. */
export const CLIENT_NAME = `tinytorrent ${VERSION}`;

/**
 * The Azureus-style peer id prefix, e.g. `-TT1000-`: major, minor and patch
 * as one base-36 character each, then a zero.
 */
export const PEER_ID_PREFIX = `-TT${VERSION.split(/[.+-]/, 3)
  .map((part) => Number(part).toString(36).toUpperCase())
  .join("")}0-`;
