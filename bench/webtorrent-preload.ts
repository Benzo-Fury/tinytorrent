/**
 * Lets WebTorrent load under Bun for comparison runs: its optional native
 * addons are replaced with stubs, exactly as Findr ships it.
 */

const stubs: Record<string, string> = {
  "webrtc-polyfill": "export const RTCPeerConnection = undefined, RTCSessionDescription = undefined, RTCIceCandidate = undefined",
  "utp-native": "module.exports = {}",
  "fs-native-extensions": "throw new Error('fs-native-extensions is not loaded')",
};

Bun.plugin({
  name: "native-stubs",
  setup(build) {
    for (const [name, contents] of Object.entries(stubs)) build.module(name, () => ({ contents, loader: "js" }));
  },
});
