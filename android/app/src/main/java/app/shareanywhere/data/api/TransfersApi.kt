package app.shareanywhere.data.api

import java.net.URLEncoder
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
private data class TurnRequest(@SerialName("session_id") val sessionId: String)

/** Transfer records and TURN credentials (docs/API.md §2.3), all with the device token (guests included). */
class TransfersApi(private val client: ApiClient, private val auth: Authorized) {
    private fun seg(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    suspend fun list(sessionId: String): TransferList = auth { token ->
        val op = ApiOperations.listTransfers
        client.call<Unit, TransferList>(op, op.path(seg(sessionId)), response = TransferList.serializer(), token = token)
    }

    /** Receiver only (the server refuses senders with 403 receiver_only). */
    suspend fun report(transferId: String, status: String, verifiedBytes: Long, route: String?): Transfer = auth { token ->
        val op = ApiOperations.reportTransfer
        client.call(
            op,
            op.path(seg(transferId)),
            TransferReport(status, verifiedBytes, route),
            TransferReport.serializer(),
            Transfer.serializer(),
            token
        )
    }

    /** pause, resume or cancel; a receiver presents its transfer capability. */
    suspend fun action(transferId: String, action: Action, capability: String? = null): Transfer = auth { token ->
        val op = action.op
        client.call(op, op.path(seg(transferId)), TransferAction(capability), TransferAction.serializer(), Transfer.serializer(), token)
    }

    suspend fun turn(sessionId: String): TurnCredentials = auth { token ->
        client.call(
            ApiOperations.createTurnCredentials,
            body = TurnRequest(sessionId),
            request = TurnRequest.serializer(),
            response = TurnCredentials.serializer(),
            token = token
        )
    }

    enum class Action(val op: ApiOperation) {
        Pause(ApiOperations.pauseTransfer),
        Resume(ApiOperations.resumeTransfer),
        Cancel(ApiOperations.cancelTransfer)
    }
}
