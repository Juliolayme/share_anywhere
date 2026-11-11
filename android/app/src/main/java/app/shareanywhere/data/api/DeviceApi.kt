package app.shareanywhere.data.api

/** Device identity endpoints (docs/API.md §2.1); native clients use the `body` refresh transport. */
class DeviceApi(private val client: ApiClient) {
    suspend fun create(request: CreateDeviceRequest): DeviceSession = client.call(
        ApiOperations.createAnonymousDevice,
        body = request,
        request = CreateDeviceRequest.serializer(),
        response = DeviceSession.serializer()
    )

    suspend fun refresh(secret: String): DeviceSession = client.call(
        ApiOperations.refreshDeviceToken,
        body = RefreshRequest(refreshSecret = secret),
        request = RefreshRequest.serializer(),
        response = DeviceSession.serializer()
    )

    suspend fun current(token: String): Device =
        client.call<Unit, Device>(ApiOperations.getCurrentDevice, response = Device.serializer(), token = token)

    suspend fun rename(token: String, displayName: String): Device = client.call(
        ApiOperations.updateCurrentDevice,
        body = UpdateDeviceRequest(displayName),
        request = UpdateDeviceRequest.serializer(),
        response = Device.serializer(),
        token = token
    )

    /** New anonymous identity; the old one is revoked by the server. Takes no body. */
    suspend fun reset(token: String): DeviceSession =
        client.call<Unit, DeviceSession>(ApiOperations.resetCurrentDevice, response = DeviceSession.serializer(), token = token)

    /** Decodes the challenge carried by a `428 pow_required` answer. */
    fun powChallenge(error: ApiException): PowChallenge? =
        error.body?.let { runCatching { client.json.decodeFromJsonElement(PowRequired.serializer(), it).challenge }.getOrNull() }
}
