package app.shareanywhere.data.api

import java.net.URLEncoder
import kotlinx.serialization.Serializable

@Serializable
private data class EstimateRequest(val bytes: Long, val receivers: Int)

@Serializable
private data class CloudObjectList(val objects: List<CloudObject>)

/** Cloud Distribution (docs/API.md §2.6). Parts travel as raw bytes. */
class CloudApi(private val client: ApiClient, private val auth: Authorized) {
    private fun seg(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    private fun part(op: ApiOperation, objectId: String, n: Int) = op.path(seg(objectId), n.toString())

    suspend fun settings(): CloudSettings = auth { t ->
        client.call<Unit, CloudSettings>(ApiOperations.getCloudSettings, response = CloudSettings.serializer(), token = t)
    }

    suspend fun putSettings(enabled: Boolean, consent: Boolean, budgetBytes: Long? = null): CloudSettings = auth { t ->
        client.call(
            ApiOperations.putCloudSettings,
            body = CloudSettingsInput(enabled, consent, budgetBytes),
            request = CloudSettingsInput.serializer(),
            response = CloudSettings.serializer(),
            token = t
        )
    }

    suspend fun estimate(bytes: Long, receivers: Int): CloudEstimate = auth { t ->
        client.call(
            ApiOperations.estimateCloud,
            body = EstimateRequest(bytes, receivers),
            request = EstimateRequest.serializer(),
            response = CloudEstimate.serializer(),
            token = t
        )
    }

    suspend fun distribute(fileId: String): CloudObject = auth { t ->
        val op = ApiOperations.distributeFile
        client.call<Unit, CloudObject>(op, op.path(seg(fileId)), response = CloudObject.serializer(), token = t)
    }

    suspend fun putPart(objectId: String, n: Int, bytes: ByteArray): CloudObject = auth { t ->
        val op = ApiOperations.putCloudPart
        client.json.decodeFromString(CloudObject.serializer(), client.sendBytes(op, part(op, objectId, n), bytes, t).decodeToString())
    }

    suspend fun seal(objectId: String): CloudObject = auth { t ->
        val op = ApiOperations.sealCloudObject
        client.call<Unit, CloudObject>(op, op.path(seg(objectId)), response = CloudObject.serializer(), token = t)
    }

    suspend fun list(sessionId: String): List<CloudObject> = auth { t ->
        val op = ApiOperations.listSessionCloudObjects
        client.call<Unit, CloudObjectList>(op, op.path(seg(sessionId)), response = CloudObjectList.serializer(), token = t).objects
    }

    suspend fun getPart(objectId: String, n: Int): ByteArray = auth { t ->
        val op = ApiOperations.getCloudPart
        client.sendBytes(op, part(op, objectId, n), null, t)
    }

    suspend fun received(objectId: String): CloudObject = auth { t ->
        val op = ApiOperations.receivedCloudObject
        client.call<Unit, CloudObject>(op, op.path(seg(objectId)), response = CloudObject.serializer(), token = t)
    }
}

/** Sessions created with Cloud transfer chosen (after the consent dialog), for this process. */
class CloudChoices {
    private val ids = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()

    fun choose(sessionId: String) {
        ids.add(sessionId)
    }

    fun chosen(sessionId: String): Boolean = sessionId in ids
}
