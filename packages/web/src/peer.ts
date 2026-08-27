import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * Direct peer-to-peer editing, with nobody in the middle.
 *
 * This is the logical end of "your files stay yours": two people editing one document with
 * no relay, no host, and no account anywhere. A WebRTC data channel carries the same Yjs
 * sync protocol the WebSocket transport uses, so the CRDT does not know or care which way
 * the bytes arrived.
 *
 * **The honest limitations**, because this is the feature most likely to disappoint:
 *
 *  - Signalling is manual. Establishing a WebRTC connection requires exchanging an offer
 *    and an answer, and a signalling *server* is exactly the middleman this feature exists
 *    to avoid. So the two blobs are copied between people by hand, over whatever channel
 *    they already trust. Clunky, and deliberately so.
 *  - It uses public STUN only. That covers most home and office networks, but symmetric
 *    NAT needs a TURN relay, and a TURN relay is a server someone has to run and pay for.
 *    Behind such a network this will fail to connect, and it says so rather than hanging.
 *  - The channel is encrypted by WebRTC (DTLS) in transit, but the invite blob is not
 *    authenticated. Anyone who intercepts it before the answer comes back could take the
 *    other end. Exchange invites over a channel you already trust.
 */

const STUN: RTCConfiguration = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
};

const ORIGIN = "peer";
const GATHER_TIMEOUT_MS = 5000;

export type PeerState = "idle" | "gathering" | "waiting" | "connected" | "failed" | "closed";

export interface PeerHandle {
  /** The blob to hand to the other person. */
  invite: string;
  /** Feed back the blob they return. */
  accept: (reply: string) => Promise<void>;
  close: () => void;
}

/** Wait for ICE gathering, but never forever: partial candidates usually still connect. */
function whenGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = (): void => {
      if (pc.iceGatheringState === "complete") done();
    };
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, GATHER_TIMEOUT_MS);
  });
}

const pack = (value: unknown): string => btoa(JSON.stringify(value));
const unpack = <T,>(blob: string): T => JSON.parse(atob(blob.trim())) as T;

function wire(doc: Y.Doc, channel: RTCDataChannel): void {
  channel.binaryType = "arraybuffer";

  const send = (payload: Uint8Array): void => {
    if (channel.readyState === "open") channel.send(payload);
  };

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === ORIGIN) return;
    const enc = encoding.createEncoder();
    writeUpdate(enc, update);
    send(encoding.toUint8Array(enc));
  });

  channel.onopen = () => {
    const enc = encoding.createEncoder();
    writeSyncStep1(enc, doc);
    send(encoding.toUint8Array(enc));
  };

  channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    const decoder = decoding.createDecoder(new Uint8Array(event.data));
    const enc = encoding.createEncoder();
    readSyncMessage(decoder, enc, doc, ORIGIN);
    if (encoding.length(enc) > 0) send(encoding.toUint8Array(enc));
  };
}

/** Start a direct session. Returns an invite to hand to the other person. */
export async function offerPeer(
  doc: Y.Doc,
  onState: (state: PeerState, detail?: string) => void,
): Promise<PeerHandle> {
  const pc = new RTCPeerConnection(STUN);
  const channel = pc.createDataChannel("quire", { ordered: true });
  wire(doc, channel);

  channel.onopen = ((original) =>
    function (this: RTCDataChannel, event: Event) {
      onState("connected");
      original?.call(this, event);
    })(channel.onopen);
  channel.onclose = () => onState("closed");

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      onState(
        "failed",
        "Could not reach the other machine. This usually means one side is behind a " +
          "network that needs a relay, which direct connection cannot provide.",
      );
    }
  };

  onState("gathering");
  await pc.setLocalDescription(await pc.createOffer());
  await whenGathered(pc);
  onState("waiting");

  return {
    invite: pack({ kind: "offer", sdp: pc.localDescription }),
    accept: async (reply: string) => {
      const { sdp } = unpack<{ sdp: RTCSessionDescriptionInit }>(reply);
      await pc.setRemoteDescription(sdp);
    },
    close: () => {
      channel.close();
      pc.close();
      onState("closed");
    },
  };
}

/** Join a direct session from someone else's invite. Returns a reply to send back. */
export async function answerPeer(
  doc: Y.Doc,
  invite: string,
  onState: (state: PeerState, detail?: string) => void,
): Promise<PeerHandle> {
  const { sdp } = unpack<{ sdp: RTCSessionDescriptionInit }>(invite);
  const pc = new RTCPeerConnection(STUN);

  pc.ondatachannel = (event) => {
    wire(doc, event.channel);
    event.channel.onopen = () => onState("connected");
    event.channel.onclose = () => onState("closed");
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") onState("failed", "Direct connection failed.");
  };

  onState("gathering");
  await pc.setRemoteDescription(sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  await whenGathered(pc);
  onState("waiting");

  return {
    invite: pack({ kind: "answer", sdp: pc.localDescription }),
    accept: async () => {
      // The answering side has nothing further to accept; the offerer completes it.
    },
    close: () => {
      pc.close();
      onState("closed");
    },
  };
}
