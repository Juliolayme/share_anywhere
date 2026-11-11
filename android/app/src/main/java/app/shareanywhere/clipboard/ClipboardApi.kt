package app.shareanywhere.clipboard

import app.shareanywhere.data.api.ApiClient
import app.shareanywhere.data.api.ApiOperations
import app.shareanywhere.data.api.Authorized
import app.shareanywhere.data.api.ClipboardEvent
import app.shareanywhere.data.api.ClipboardEventCreated
import app.shareanywhere.data.api.ClipboardEventPage
import app.shareanywhere.data.api.ClipboardEventRequest
import app.shareanywhere.data.api.ClipboardHistory
import app.shareanywhere.data.api.ClipboardSettings
import java.net.URLEncoder

/** Clipboard Sync endpoints (docs/API.md §2.5, docs/CLIPBOARD_PROTOCOL.md §2). Every route is `account+device`. */
interface ClipboardEndpoints {
    suspend fun history(limit: Int = 100): ClipboardHistory

    suspend fun events(cursor: Long, limit: Int = 100): ClipboardEventPage

    suspend fun create(req: ClipboardEventRequest): ClipboardEventCreated

    suspend fun remove(eventId: String)

    suspend fun clear()

    suspend fun settings(): ClipboardSettings

    suspend fun saveSettings(s: ClipboardSettings): ClipboardSettings
}

class ClipboardApi(private val client: ApiClient, private val auth: Authorized) : ClipboardEndpoints {
    private fun seg(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    override suspend fun history(limit: Int): ClipboardHistory = auth { t ->
        client.call<Unit, ClipboardHistory>(
            ApiOperations.getClipboardHistory,
            response = ClipboardHistory.serializer(),
            token = t,
            query = mapOf("limit" to limit.toString())
        )
    }

    override suspend fun events(cursor: Long, limit: Int): ClipboardEventPage = auth { t ->
        client.call<Unit, ClipboardEventPage>(
            ApiOperations.listClipboardEvents,
            response = ClipboardEventPage.serializer(),
            token = t,
            query = mapOf("cursor" to cursor.toString(), "limit" to limit.toString())
        )
    }

    override suspend fun create(req: ClipboardEventRequest): ClipboardEventCreated = auth { t ->
        client.call(
            ApiOperations.createClipboardEvent,
            body = req,
            request = ClipboardEventRequest.serializer(),
            response = ClipboardEventCreated.serializer(),
            token = t
        )
    }

    override suspend fun remove(eventId: String) {
        auth { t ->
            val op = ApiOperations.deleteClipboardEvent
            client.send(op, op.path(seg(eventId)), token = t)
        }
    }

    override suspend fun clear() {
        auth { t -> client.send(ApiOperations.clearClipboardHistory, token = t) }
    }

    override suspend fun settings(): ClipboardSettings = auth { t ->
        client.call<Unit, ClipboardSettings>(ApiOperations.getClipboardSettings, response = ClipboardSettings.serializer(), token = t)
    }

    override suspend fun saveSettings(s: ClipboardSettings): ClipboardSettings = auth { t ->
        client.call(
            ApiOperations.putClipboardSettings,
            body = s,
            request = ClipboardSettings.serializer(),
            response = ClipboardSettings.serializer(),
            token = t
        )
    }

    companion object {
        /** Payload limit (PRD §7.6): UTF-8 bytes of the plaintext. */
        const val MAX_PAYLOAD_BYTES = 262_144

        /** Live events the server keeps per account. */
        const val MAX_EVENTS = 100
    }
}

/** A tombstone, or an event without a payload (never shown). */
val ClipboardEvent.isLive: Boolean get() = !deleted && ciphertext != null && nonce != null
