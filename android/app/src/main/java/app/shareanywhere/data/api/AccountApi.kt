package app.shareanywhere.data.api

import java.net.URLEncoder
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
private data class EmailRequest(val email: String)

@Serializable
private data class ResetConfirm(val token: String, val password: String)

@Serializable
private data class HistorySyncRequest(@SerialName("history_sync") val historySync: Boolean)

@Serializable
private data class PasswordChange(@SerialName("current_password") val current: String, @SerialName("new_password") val next: String)

@Serializable
private data class AddCurrent(@SerialName("copy_history") val copyHistory: Boolean)

@Serializable
private data class RenameRequest(val name: String)

@Serializable
private data class EphemeralKey(@SerialName("ephemeral_public_key") val ephemeralPublicKey: String)

@Serializable
data class DeviceKeyRequest(
    @SerialName("public_key") val publicKey: String,
    @SerialName("key_version") val keyVersion: Int,
    val proof: String
)

@Serializable
data class AccountDeviceList(val devices: List<AccountDevice>)

@Serializable
data class KeyChain(val chain: List<ChainLink>, val versions: List<KeyVersionInfo>)

/**
 * Account calls (docs/API.md §2.4), all with the device access token: sign-in layers an account session on the
 * device identity (the `acct` claim), so guests and signed-in devices use one identity (ADR 0002, ADR 0010).
 * Native clients never get the Web's browser-session binding cookie.
 */
class AccountApi(private val client: ApiClient, private val auth: Authorized) {
    private fun seg(v: String) = URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    suspend fun signUp(email: String, password: String, addDevice: Boolean): AuthResult = auth { t ->
        client.call(
            ApiOperations.signUp,
            body = CredentialsRequest(email, password, addDevice, false),
            request = CredentialsRequest.serializer(),
            response = AuthResult.serializer(),
            token = t
        )
    }

    suspend fun signIn(email: String, password: String, addDevice: Boolean): AuthResult = auth { t ->
        client.call(
            ApiOperations.signIn,
            body = CredentialsRequest(email, password, addDevice, false),
            request = CredentialsRequest.serializer(),
            response = AuthResult.serializer(),
            token = t
        )
    }

    /** A brand-new anonymous device replaces this one (docs/API.md §2.4 Sign-out). */
    suspend fun signOut(): DeviceSession = auth { t ->
        client.call<Unit, DeviceSession>(ApiOperations.signOut, response = DeviceSession.serializer(), token = t)
    }

    suspend fun requestReset(email: String) {
        client.send(
            ApiOperations.requestPasswordReset,
            bodyJson = client.json.encodeToString(EmailRequest.serializer(), EmailRequest(email))
        )
    }

    suspend fun confirmReset(token: String, password: String) {
        client.send(
            ApiOperations.confirmPasswordReset,
            bodyJson = client.json.encodeToString(ResetConfirm.serializer(), ResetConfirm(token, password))
        )
    }

    suspend fun me(): Me = auth { t -> client.call<Unit, Me>(ApiOperations.getMe, response = Me.serializer(), token = t) }

    suspend fun setHistorySync(on: Boolean): Me = auth { t ->
        client.call(
            ApiOperations.updateMe,
            body = HistorySyncRequest(on),
            request = HistorySyncRequest.serializer(),
            response = Me.serializer(),
            token = t
        )
    }

    suspend fun changePassword(current: String, next: String) {
        auth { t ->
            client.send(
                ApiOperations.changePassword,
                bodyJson = client.json.encodeToString(PasswordChange.serializer(), PasswordChange(current, next)),
                token = t
            )
        }
    }

    suspend fun addCurrent(copyHistory: Boolean): AccountToken = auth { t ->
        client.call(
            ApiOperations.addCurrentDevice,
            body = AddCurrent(copyHistory),
            request = AddCurrent.serializer(),
            response = AccountToken.serializer(),
            token = t
        )
    }

    suspend fun devices(): AccountDeviceList = auth { t ->
        client.call<Unit, AccountDeviceList>(ApiOperations.listAccountDevices, response = AccountDeviceList.serializer(), token = t)
    }

    suspend fun renameDevice(id: String, name: String): AccountDevice = auth { t ->
        val op = ApiOperations.renameAccountDevice
        client.call(op, op.path(seg(id)), RenameRequest(name), RenameRequest.serializer(), AccountDevice.serializer(), t)
    }

    suspend fun revokeDevice(id: String) {
        auth { t ->
            val op = ApiOperations.revokeAccountDevice
            client.send(op, op.path(seg(id)), token = t)
        }
    }

    suspend fun keys(): KeysState = auth { t ->
        client.call<Unit, KeysState>(ApiOperations.getKeys, response = KeysState.serializer(), token = t)
    }

    suspend fun registerKey(req: DeviceKeyRequest) {
        auth { t ->
            client.send(
                ApiOperations.registerDeviceKey,
                bodyJson = client.json.encodeToString(DeviceKeyRequest.serializer(), req),
                token = t
            )
        }
    }

    suspend fun setupKeys(req: KeysSetupRequest): KeyVersion = auth { t ->
        client.call(
            ApiOperations.setupKeys,
            body = req,
            request = KeysSetupRequest.serializer(),
            response = KeyVersion.serializer(),
            token = t
        )
    }

    suspend fun recovery(): RecoveryBlob = auth { t ->
        client.call<Unit, RecoveryBlob>(ApiOperations.getRecoveryBlob, response = RecoveryBlob.serializer(), token = t)
    }

    suspend fun rotate(req: KeysRotateRequest): KeyVersion = auth { t ->
        client.call(
            ApiOperations.rotateKeys,
            body = req,
            request = KeysRotateRequest.serializer(),
            response = KeyVersion.serializer(),
            token = t
        )
    }

    suspend fun chain(): KeyChain = auth { t ->
        client.call<Unit, KeyChain>(ApiOperations.getKeyChain, response = KeyChain.serializer(), token = t)
    }

    suspend fun ackPending(keyVersion: Int) {
        auth { t ->
            val op = ApiOperations.ackPendingKey
            client.send(op, op.path(keyVersion.toString()), token = t)
        }
    }

    suspend fun createPairing(ephemeralPublicKey: String): Pairing = auth { t ->
        client.call(
            ApiOperations.createPairing,
            body = EphemeralKey(ephemeralPublicKey),
            request = EphemeralKey.serializer(),
            response = Pairing.serializer(),
            token = t
        )
    }

    suspend fun pairingStatus(id: String): PairingStatus = auth { t ->
        val op = ApiOperations.getPairingResult
        client.call<Unit, PairingStatus>(op, op.path(seg(id)), response = PairingStatus.serializer(), token = t)
    }

    suspend fun lookupPairing(code: String): PairingPeer = auth { t ->
        val op = ApiOperations.lookupPairing
        client.call<Unit, PairingPeer>(op, op.path(seg(code)), response = PairingPeer.serializer(), token = t)
    }

    suspend fun wrapPairing(code: String, req: PairingWrapRequest) {
        auth { t ->
            val op = ApiOperations.wrapPairing
            client.send(op, op.path(seg(code)), client.json.encodeToString(PairingWrapRequest.serializer(), req), t)
        }
    }

    suspend fun historyEntries(after: Long, limit: Int = 200): HistoryPage = auth { t ->
        client.call<Unit, HistoryPage>(
            ApiOperations.listHistoryEntries,
            response = HistoryPage.serializer(),
            token = t,
            query = mapOf(
                "after" to after.toString(),
                "limit" to limit.toString()
            )
        )
    }

    suspend fun addHistoryEntry(req: HistoryEntryRequest): Long = auth { t ->
        client.call(
            ApiOperations.createHistoryEntry,
            body = req,
            request = HistoryEntryRequest.serializer(),
            response = SeqResponse.serializer(),
            token = t
        ).seq
    }

    suspend fun deleteHistoryEntry(id: String) {
        auth { t ->
            val op = ApiOperations.deleteHistoryEntry
            client.send(op, op.path(seg(id)), token = t)
        }
    }

    suspend fun clearHistory() {
        auth { t -> client.send(ApiOperations.clearHistory, token = t) }
    }
}

@Serializable
data class SeqResponse(val seq: Long)
