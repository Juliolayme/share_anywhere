package app.shareanywhere.data.api

import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/** An error response from the API (docs/API.md §3): HTTP status, machine-readable `error` code, wait hint. */
class ApiException(val status: Int, val code: String, message: String, val retryAfterSeconds: Int? = null, val body: JsonObject? = null) :
    Exception(message)

/** The backend could not be reached (offline, DNS, refused, timed out). */
class NetworkException(cause: Throwable) : IOException(cause.message, cause)

/**
 * Thin JSON client over OkHttp for the operations in the generated [ApiOperations] (docs/ADR/0016-android-networking.md).
 * It never logs requests, bodies or headers, so tokens and refresh secrets cannot reach a log
 * (docs/SECURITY_MODEL.md §8). Release builds refuse a cleartext base URL.
 */
class ApiClient(baseUrl: String, private val http: OkHttpClient, val json: Json, requireHttps: Boolean, private val userAgent: String) {
    private val base: HttpUrl = baseUrl.trimEnd('/').toHttpUrl()

    init {
        require(!requireHttps || base.isHttps) { "Release builds talk to the backend over HTTPS only" }
    }

    /** Sends [op] with an optional JSON [body] and bearer [token]; decodes the response with [response]. */
    suspend fun <Req, Res> call(
        op: ApiOperation,
        path: String = op.path,
        body: Req? = null,
        request: KSerializer<Req>? = null,
        response: KSerializer<Res>,
        token: String? = null,
        query: Map<String, String> = emptyMap()
    ): Res {
        val text = send(op, path, body?.let { json.encodeToString(requireNotNull(request), it) }, token, query)
        return json.decodeFromString(response, text)
    }

    /** Sends [op] and returns the raw response body (empty for 204). */
    suspend fun send(
        op: ApiOperation,
        path: String = op.path,
        bodyJson: String? = null,
        token: String? = null,
        query: Map<String, String> = emptyMap()
    ): String {
        val url = base.newBuilder().encodedPath(path).apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val builder =
            Request
                .Builder()
                .url(url)
                .header("Accept", "application/json")
                .header("User-Agent", userAgent)
        if (token != null) builder.header("Authorization", "Bearer $token")
        val requestBody = bodyJson?.toRequestBody(JSON)
        builder.method(op.method, requestBody ?: if (op.method == "POST" || op.method == "PUT" || op.method == "PATCH") EMPTY else null)
        val res =
            try {
                http.newCall(builder.build()).await()
            } catch (e: IOException) {
                throw NetworkException(e)
            }
        res.use {
            val text = it.body?.string().orEmpty()
            if (it.isSuccessful) return text
            throw toApiException(it, text)
        }
    }

    /**
     * Sends [op] with a raw `application/octet-stream` [body] (or none) and returns the raw response bytes: Cloud
     * Distribution parts (docs/API.md §2.6).
     */
    suspend fun sendBytes(op: ApiOperation, path: String, body: ByteArray?, token: String?): ByteArray {
        val url = base.newBuilder().encodedPath(path).build()
        val builder =
            Request
                .Builder()
                .url(url)
                .header("Accept", if (body == null) "application/octet-stream" else "application/json")
                .header("User-Agent", userAgent)
        if (token != null) builder.header("Authorization", "Bearer $token")
        builder.method(op.method, body?.toRequestBody(OCTET) ?: if (op.method == "POST" || op.method == "PUT") EMPTY else null)
        val res =
            try {
                http.newCall(builder.build()).await()
            } catch (e: IOException) {
                throw NetworkException(e)
            }
        res.use {
            val bytes = it.body?.bytes() ?: ByteArray(0)
            if (it.isSuccessful) return bytes
            throw toApiException(it, bytes.decodeToString())
        }
    }

    private fun toApiException(res: Response, text: String): ApiException {
        val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
        val code = obj?.get("error")?.jsonPrimitive?.content ?: "http_${res.code}"
        val message = obj?.get("message")?.jsonPrimitive?.content ?: res.message
        val retry =
            obj?.get("retry_after_s")?.jsonPrimitive?.intOrNull
                ?: res.header("Retry-After")?.toIntOrNull()?.takeIf { it > 0 }
        return ApiException(res.code, code, message, retry, obj)
    }

    private companion object {
        val JSON = "application/json".toMediaType()
        val OCTET = "application/octet-stream".toMediaType()
        val EMPTY = ByteArray(0).toRequestBody(null)
    }
}

/** Suspends until OkHttp answers; cancelling the coroutine cancels the call. */
private suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { cancel() }
    enqueue(
        object : Callback {
            override fun onResponse(call: Call, response: Response) = cont.resume(response)

            override fun onFailure(call: Call, e: IOException) = cont.resumeWithException(e)
        }
    )
}
