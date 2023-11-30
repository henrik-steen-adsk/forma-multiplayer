import { useEffect, useState } from "preact/hooks";

export default function WebRtcChat() {
  const [localOffer, setLocalOffer] = useState<string>("");

  const rtcConfiguration = {
    iceServers: [{ urls: "stun:stun.gmx.net" }],
  };
  const connection = new RTCPeerConnection(rtcConfiguration);

  connection.onicecandidate = function (e) {
    if (e.candidate == null) {
      setLocalOffer(JSON.stringify(connection.localDescription));
    }
  };

  useEffect(() => {
    const dc1 = connection.createDataChannel("test", {});
    dc1.onopen = function (e) {};
    dc1.onmessage = function (e) {
      if (e.data.charCodeAt(0) == 2) {
        return;
      }
      var data = JSON.parse(e.data);
      console.log(data);
    };
    connection.createOffer(
      function (desc) {
        connection.setLocalDescription(
          desc,
          function () {},
          function () {},
        );
      },
      function () {},
      {},
    );
  }, []);

  return <div>{localOffer}</div>;
}
