package app.shareanywhere.transfer.runtime

import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver

/** PeerConnection.Observer with no-op defaults; data-channel transfers need only a few callbacks. */
open class PeerObserver : PeerConnection.Observer {
    override fun onSignalingChange(state: PeerConnection.SignalingState) {}

    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}

    override fun onIceConnectionReceivingChange(receiving: Boolean) {}

    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}

    override fun onIceCandidate(candidate: IceCandidate) {}

    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}

    override fun onAddStream(stream: MediaStream) {}

    override fun onRemoveStream(stream: MediaStream) {}

    override fun onDataChannel(channel: DataChannel) {}

    override fun onRenegotiationNeeded() {}

    override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}

    override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {}
}
