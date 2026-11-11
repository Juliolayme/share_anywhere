package app.shareanywhere.data.api

import java.net.URLEncoder
import kotlinx.serialization.Serializable

/** A participant decision (docs/API.md §2.2). `leave` is the receiver's own; the others are the sender's. */
enum class Decision(val op: ApiOperation) {
    Approve(ApiOperations.approveParticipant),
    Reject(ApiOperations.rejectParticipant),
    Block(ApiOperations.blockParticipant),
    Leave(ApiOperations.leaveSession)
}

@Serializable
private data class CodeRequest(val code: String)

@Serializable
private data class LinkRequest(val token: String)

@Serializable
private data class TicketRequest(val ticket: String)

/**
 * Share-session calls (docs/API.md §2.2), every one with the device access token through [Authorized], so guests
 * and signed-in devices use the same calls (PRD §2: file sharing never needs an account).
 */
class SessionsApi(private val client: ApiClient, private val auth: Authorized) {
    suspend fun create(files: List<FileInput>, requireApproval: Boolean): SessionView = auth { token ->
        client.call(
            ApiOperations.createSession,
            body = CreateSessionRequest(files, requireApproval),
            request = CreateSessionRequest.serializer(),
            response = SessionView.serializer(),
            token = token
        )
    }

    suspend fun listOpen(): OpenSessionList = auth { token ->
        client.call<Unit, OpenSessionList>(ApiOperations.listOpenSessions, response = OpenSessionList.serializer(), token = token)
    }

    suspend fun get(id: String): SessionView = auth { token ->
        val op = ApiOperations.getSession
        client.call<Unit, SessionView>(op, op.path(seg(id)), response = SessionView.serializer(), token = token)
    }

    suspend fun update(id: String, body: UpdateSessionRequest): SessionView = auth { token ->
        val op = ApiOperations.updateSession
        client.call(op, op.path(seg(id)), body, UpdateSessionRequest.serializer(), SessionView.serializer(), token)
    }

    suspend fun renew(id: String): SessionView = auth { token ->
        val op = ApiOperations.renewSession
        client.call<Unit, SessionView>(op, op.path(seg(id)), response = SessionView.serializer(), token = token)
    }

    suspend fun close(id: String) {
        auth { token ->
            val op = ApiOperations.closeSession
            client.send(op, op.path(seg(id)), token = token)
        }
    }

    suspend fun resolveCode(code: String): JoinPreview = auth { token ->
        client.call(
            ApiOperations.resolveCode,
            body = CodeRequest(code),
            request = CodeRequest.serializer(),
            response = JoinPreview.serializer(),
            token = token
        )
    }

    suspend fun resolveLink(linkToken: String): JoinPreview = auth { token ->
        client.call(
            ApiOperations.resolveLink,
            body = LinkRequest(linkToken),
            request = LinkRequest.serializer(),
            response = JoinPreview.serializer(),
            token = token
        )
    }

    suspend fun join(sessionId: String, ticket: String): JoinResult = auth { token ->
        val op = ApiOperations.joinSession
        client.call(op, op.path(seg(sessionId)), TicketRequest(ticket), TicketRequest.serializer(), JoinResult.serializer(), token)
    }

    suspend fun decide(participantId: String, decision: Decision): Participant = auth { token ->
        val op = decision.op
        client.call<Unit, Participant>(op, op.path(seg(participantId)), response = Participant.serializer(), token = token)
    }

    suspend fun remove(participantId: String): Participant = auth { token ->
        val op = ApiOperations.removeParticipant
        client.call<Unit, Participant>(op, op.path(seg(participantId)), response = Participant.serializer(), token = token)
    }

    /** One-time WebSocket ticket (30 s, docs/API.md §4). */
    suspend fun wsTicket(): WsTicket = auth { token ->
        client.call<Unit, WsTicket>(ApiOperations.createWsTicket, response = WsTicket.serializer(), token = token)
    }

    private companion object {
        /** Path segments are URL-encoded even though the server sends UUIDs (ids can come from deep links). */
        fun seg(v: String): String = URLEncoder.encode(v, "UTF-8").replace("+", "%20")
    }
}

/** Runs a call with a valid device access token, refreshing once on 401 (IdentityManager.authorized). */
interface Authorized {
    suspend operator fun <T> invoke(block: suspend (token: String) -> T): T
}
