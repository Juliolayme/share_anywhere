package app.shareanywhere.account.crypto

import app.shareanywhere.account.crypto.Primitives.KEY_BYTES
import app.shareanywhere.account.crypto.Primitives.NONCE_BYTES
import app.shareanywhere.account.crypto.Primitives.TAG_BYTES

/** Account Data Key subkeys (§1.2): HKDF-SHA256(ADK, salt = empty, info = label, 32). */
object Adk {
    const val CLIPBOARD = "clipboard-v1"
    const val HISTORY = "history-v1"

    fun subkey(adk: ByteArray, label: String): ByteArray {
        require(adk.size == KEY_BYTES) { "ADK size" }
        return Primitives.hkdf(adk, ByteArray(0), label.toByteArray())
    }
}

/** One encrypted clipboard event or history entry (§1.3). */
class EncryptedItem(val nonce: ByteArray, val ciphertext: ByteArray)

object Items {
    private val ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    /** Ids are the lowercase canonical UUID text, which is also what goes into the AAD (§1.3). */
    fun isItemId(id: String) = ID.matches(id)

    fun newItemId(): String = java.util.UUID.randomUUID().toString()

    /** History entry ids are version-8 UUIDs from the first 16 bytes of a SHA-256 (as the Web's itemIdFromBytes). */
    fun itemIdFromBytes(bytes: ByteArray): String {
        val b = bytes.copyOf(16)
        b[6] = ((b[6].toInt() and 0x0F) or 0x80).toByte()
        b[8] = ((b[8].toInt() and 0x3F) or 0x80).toByte()
        val h = b.toHex()
        return "${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20, 32)}"
    }

    fun aad(id: String, keyVersion: Int): ByteArray {
        if (!isItemId(id) || keyVersion < 1) throw CryptoException("invalid_input", "item id or key version")
        return "$id|$keyVersion".toByteArray()
    }

    fun encrypt(
        subkey: ByteArray,
        id: String,
        keyVersion: Int,
        plaintext: ByteArray,
        nonce: ByteArray = Primitives.random(NONCE_BYTES)
    ): EncryptedItem = EncryptedItem(nonce, Primitives.aesGcmSeal(subkey, nonce, plaintext, aad(id, keyVersion)))

    fun decrypt(subkey: ByteArray, id: String, keyVersion: Int, item: EncryptedItem): ByteArray =
        Primitives.aesGcmOpen(subkey, item.nonce, item.ciphertext, aad(id, keyVersion))
}

/** ECIES wrapping of an ADK to an X25519 public key, and the version chain (§1.4, §1.5). */
object Wrap {
    const val INFO = "sa-wrap-v1"
    const val WRAPPED_BYTES = KEY_BYTES + NONCE_BYTES + KEY_BYTES + TAG_BYTES // 92
    const val CHAIN_BYTES = NONCE_BYTES + KEY_BYTES + TAG_BYTES // 60
    val PURPOSES = setOf("pair", "rotate", "recovery")

    fun aad(purpose: String, keyVersion: Int): ByteArray {
        if (purpose !in PURPOSES || keyVersion < 1) throw CryptoException("invalid_input", "wrap purpose or version")
        return "$purpose|$keyVersion".toByteArray()
    }

    fun wrapKey(shared: ByteArray, senderPublic: ByteArray, recipientPublic: ByteArray): ByteArray =
        Primitives.hkdf(shared, senderPublic + recipientPublic, INFO.toByteArray())

    /** blob = sender_pub (32) ‖ nonce (12) ‖ AES-256-GCM(key, nonce, ADK, aad) (48). */
    fun wrap(
        adk: ByteArray,
        senderPrivate: ByteArray,
        recipientPublic: ByteArray,
        purpose: String,
        keyVersion: Int,
        nonce: ByteArray = Primitives.random(NONCE_BYTES)
    ): ByteArray {
        val senderPublic = Primitives.x25519PublicKey(senderPrivate)
        val shared = Primitives.x25519(senderPrivate, recipientPublic)
        val key = wrapKey(shared, senderPublic, recipientPublic)
        try {
            return senderPublic + nonce + Primitives.aesGcmSeal(key, nonce, adk, aad(purpose, keyVersion))
        } finally {
            Primitives.zero(shared, key)
        }
    }

    fun senderPublicKey(blob: ByteArray): ByteArray {
        if (blob.size != WRAPPED_BYTES) throw CryptoException("invalid_blob")
        return blob.copyOfRange(0, KEY_BYTES)
    }

    fun unwrap(blob: ByteArray, recipientPrivate: ByteArray, purpose: String, keyVersion: Int): ByteArray {
        if (blob.size != WRAPPED_BYTES) throw CryptoException("invalid_blob")
        val senderPublic = blob.copyOfRange(0, KEY_BYTES)
        val nonce = blob.copyOfRange(KEY_BYTES, KEY_BYTES + NONCE_BYTES)
        val sealed = blob.copyOfRange(KEY_BYTES + NONCE_BYTES, blob.size)
        val recipientPublic = Primitives.x25519PublicKey(recipientPrivate)
        val shared = Primitives.x25519(recipientPrivate, senderPublic)
        val key = wrapKey(shared, senderPublic, recipientPublic)
        try {
            return Primitives.aesGcmOpen(key, nonce, sealed, aad(purpose, keyVersion))
        } finally {
            Primitives.zero(shared, key)
        }
    }

    fun chainAad(keyVersion: Int): ByteArray {
        if (keyVersion < 2) throw CryptoException("invalid_input", "chain version")
        return "chain|$keyVersion".toByteArray()
    }

    /** chain blob v = nonce ‖ AES-256-GCM(ADK(v), nonce, ADK(v-1), "chain|v"). */
    fun wrapChain(previous: ByteArray, newer: ByteArray, keyVersion: Int, nonce: ByteArray = Primitives.random(NONCE_BYTES)): ByteArray =
        nonce + Primitives.aesGcmSeal(newer, nonce, previous, chainAad(keyVersion))

    fun unwrapChain(blob: ByteArray, newer: ByteArray, keyVersion: Int): ByteArray {
        if (blob.size != CHAIN_BYTES) throw CryptoException("invalid_blob")
        return Primitives.aesGcmOpen(
            newer,
            blob.copyOfRange(0, NONCE_BYTES),
            blob.copyOfRange(NONCE_BYTES, blob.size),
            chainAad(keyVersion)
        )
    }
}

/** BIP-39 English phrases, wordlist and checksum only (§1.6); Argon2id derives the key, not PBKDF2. */
object Phrase {
    const val WORDS = 12
    const val ENTROPY_BYTES = 16

    val wordlist: List<String> by lazy {
        requireNotNull(Phrase::class.java.getResourceAsStream("/bip39-english.txt")) {
            "bip39-english.txt missing"
        }.bufferedReader().readLines().map { it.trim() }.filter { it.isNotEmpty() }.also {
            check(it.size == 2048) { "BIP-39 wordlist must have 2048 words" }
        }
    }
    private val index: Map<String, Int> by lazy { wordlist.withIndex().associate { it.value to it.index } }

    /** NFKD, lower case, trimmed, single ASCII spaces. */
    fun normalize(input: String): String = java.text.Normalizer.normalize(
        input,
        java.text.Normalizer.Form.NFKD
    ).lowercase(java.util.Locale.ROOT).trim().split(Regex("\\s+")).filter {
        it.isNotEmpty()
    }.joinToString(" ")

    fun fromEntropy(entropy: ByteArray): String {
        require(entropy.size in 16..32 && entropy.size % 4 == 0) { "BIP-39 entropy must be 16-32 bytes in steps of 4" }
        val cs = entropy.size / 4
        val bits = StringBuilder()
        for (b in entropy) bits.append((b.toInt() and 0xFF).toString(2).padStart(8, '0'))
        bits.append((Primitives.sha256(entropy)[0].toInt() and 0xFF).toString(2).padStart(8, '0').substring(0, cs))
        return (0 until bits.length / 11).joinToString(" ") { i -> wordlist[bits.substring(i * 11, i * 11 + 11).toInt(2)] }
    }

    fun generate(): String {
        val e = Primitives.random(ENTROPY_BYTES)
        try {
            return fromEntropy(e)
        } finally {
            Primitives.zero(e)
        }
    }

    /** Why a typed phrase is not a recovery phrase: word_count, unknown_word (with the word) or checksum; null when valid. */
    data class Problem(val reason: String, val word: String? = null)

    fun check(input: String): Problem? {
        val words = normalize(input).split(' ').filter { it.isNotEmpty() }
        if (words.size != WORDS) return Problem("word_count")
        words.firstOrNull { it !in index }?.let { return Problem("unknown_word", it) }
        return try {
            Primitives.zero(toEntropy(words.joinToString(" ")))
            null
        } catch (e: CryptoException) {
            Problem(e.message ?: "checksum")
        }
    }

    fun toEntropy(input: String): ByteArray {
        val words = normalize(input).split(' ')
        if (words.size < 12 || words.size > 24 || words.size % 3 != 0) throw CryptoException("invalid_phrase", "word_count")
        val bits = StringBuilder()
        for (w in words) bits.append((index[w] ?: throw CryptoException("invalid_phrase", "unknown_word")).toString(2).padStart(11, '0'))
        val cs = words.size / 3
        val entBits = bits.length - cs
        val entropy = ByteArray(entBits / 8) { i -> bits.substring(i * 8, i * 8 + 8).toInt(2).toByte() }
        val expected = (Primitives.sha256(entropy)[0].toInt() and 0xFF).toString(2).padStart(8, '0').substring(0, cs)
        if (bits.substring(entBits) != expected) {
            Primitives.zero(entropy)
            throw CryptoException("invalid_phrase", "checksum")
        }
        return entropy
    }
}

/** The recovery keypair and anchor key from a phrase (§1.6, §1.13). */
object Recovery {
    class Derived(val seed: ByteArray, val privateKey: ByteArray, val publicKey: ByteArray)

    fun derive(phrase: String, salt: ByteArray, params: Primitives.ArgonParams): Derived {
        Primitives.checkArgon(params, salt)
        val password = Phrase.normalize(phrase).toByteArray()
        try {
            val seed = Primitives.argon2id(password, salt, params)
            val priv = Primitives.clamp(seed)
            return Derived(seed, priv, Primitives.x25519PublicKey(priv))
        } finally {
            Primitives.zero(password)
        }
    }
}

/** Version signing keys, proofs and the recovery anchor (§1.13). */
object Authenticity {
    const val SIGN_INFO = "sa-keyver-sign-v1"
    const val ANCHOR_INFO = "sa-recovery-anchor-v1"

    fun signSeed(adk: ByteArray): ByteArray = Primitives.hkdf(adk, ByteArray(0), SIGN_INFO.toByteArray())

    fun verifyKey(adk: ByteArray): ByteArray {
        val seed = signSeed(adk)
        try {
            return Primitives.ed25519PublicKey(seed)
        } finally {
            Primitives.zero(seed)
        }
    }

    fun sign(adk: ByteArray, message: String): ByteArray {
        val seed = signSeed(adk)
        try {
            return Primitives.ed25519Sign(seed, message.toByteArray())
        } finally {
            Primitives.zero(seed)
        }
    }

    fun verify(signature: ByteArray, message: String, verifyKey: ByteArray) =
        Primitives.ed25519Verify(signature, message.toByteArray(), verifyKey)

    fun rotationMessage(keyVersion: Int, verifyKey: ByteArray, chainBlob: ByteArray) =
        "sa-rotate-v1|$keyVersion|${B64u.encode(verifyKey)}|${B64u.encode(Primitives.sha256(chainBlob))}"

    fun deviceKeyMessage(deviceId: String, keyVersion: Int, publicKey: ByteArray): String {
        if (!Items.isItemId(deviceId)) throw CryptoException("invalid_input", "device id")
        return "sa-devkey-v1|$deviceId|$keyVersion|${B64u.encode(publicKey)}"
    }

    fun recoveryKeyMessage(recoveryPublicKey: ByteArray) = "sa-recoverykey-v1|${B64u.encode(recoveryPublicKey)}"

    fun anchorMessage(verifyKeyV1: ByteArray) = "sa-anchor-v1|${B64u.encode(verifyKeyV1)}"

    fun anchorKey(recoverySeed: ByteArray): ByteArray = Primitives.hkdf(recoverySeed, ByteArray(0), ANCHOR_INFO.toByteArray())

    fun recoveryAnchor(anchorKey: ByteArray, verifyKeyV1: ByteArray): ByteArray =
        Primitives.hmacSha256(anchorKey, anchorMessage(verifyKeyV1).toByteArray())
}
