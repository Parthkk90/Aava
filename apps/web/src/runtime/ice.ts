import type { TurnServer } from "./settings.ts";

/**
 * Gathers ICE candidates from a real RTCPeerConnection. Used by the
 * Observatory to check what a peer would learn about this device.
 */
export function gatherIceCandidates(config: RTCConfiguration, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection(config);
    } catch (e) {
      reject(e);
      return;
    }
    const out: string[] = [];
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      pc.close();
      resolve(out);
    };
    const timer = setTimeout(done, timeoutMs);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        if (e.candidate.candidate) out.push(e.candidate.candidate);
      } else {
        clearTimeout(timer);
        done();
      }
    };
    pc.createDataChannel("relaymesh-probe");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch((e) => {
        clearTimeout(timer);
        if (!finished) {
          finished = true;
          pc.close();
          reject(e);
        }
      });
  });
}

/**
 * The only way Aava code may construct peer connections: enforces the
 * user's relay-only policy so a future P2P feature cannot forget it.
 */
export function createPolicyPeerConnection(turnServers: TurnServer[], relayOnly: boolean): RTCPeerConnection {
  if (relayOnly && turnServers.length === 0) throw new Error("Relay-only mode needs at least one TURN server; connection would leak nothing but also never connect.");
  return new RTCPeerConnection({ iceServers: turnServers, iceTransportPolicy: relayOnly ? "relay" : "all" });
}
