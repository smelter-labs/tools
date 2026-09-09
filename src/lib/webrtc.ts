export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    bundlePolicy: "max-bundle",
  });
}

export async function gatherICECandidates(
  pc: RTCPeerConnection,
): Promise<RTCSessionDescription | null> {
  return new Promise((res) => {
    setTimeout(() => res(pc.localDescription), 2000);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") {
        res(pc.localDescription);
      }
    };
  });
}

export async function postSdpOffer(endpoint: string, sdpOffer: string, token: string) {
  const response = await fetch(endpoint, {
    method: "POST",
    mode: "cors",
    headers: {
      "content-type": "application/sdp",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: sdpOffer,
  });

  if (response.status === 201) {
    const locationHeader = response.headers.get("Location");
    const location = locationHeader ? new URL(locationHeader, endpoint).toString() : endpoint;
    return { sdp: await response.text(), location };
  }
  throw new Error(await response.text());
}

export async function negotiate(pc: RTCPeerConnection, endpoint: string, token: string) {
  await pc.setLocalDescription(await pc.createOffer());
  const offer = await gatherICECandidates(pc);
  if (!offer) throw new Error("Failed to gather ICE candidates for offer");

  const { sdp: sdpAnswer, location } = await postSdpOffer(endpoint, offer.sdp!, token);
  await pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: sdpAnswer }));
  return location ?? endpoint;
}
