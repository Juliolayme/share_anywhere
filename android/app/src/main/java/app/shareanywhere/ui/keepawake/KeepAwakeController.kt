package app.shareanywhere.ui.keepawake

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/** Screen-on pill states on Android (docs/ARCHITECTURE.md §7.3); Unsupported and Refused are Web-only. */
enum class PillState { On, Off, Paused, SetOff }

/**
 * The app's single keep-awake controller (docs/ARCHITECTURE.md §7.1). Screens that send, receive or wait for a
 * peer [hold] it while they need the screen on; it is active while any holder needs it. The screen stays on while
 * it is active, the setting "Keep screen on during transfers" is on, and the user has not tapped the pill off;
 * that choice resets when nothing holds the controller any more (the next session starts with the screen on).
 */
class KeepAwakeController {
    private data class S(val holders: Set<Any> = emptySet(), val settingOn: Boolean = true, val userOff: Boolean = false)

    private val s = MutableStateFlow(S())
    private val _pill = MutableStateFlow(PillState.Paused)
    private val _screenOn = MutableStateFlow(false)

    /** What the pill shows. */
    val pill: StateFlow<PillState> = _pill.asStateFlow()

    /** Whether the Activity window keeps the screen on (applied with View.keepScreenOn, §7.2). */
    val screenOn: StateFlow<Boolean> = _screenOn.asStateFlow()

    /** One screen says whether it needs the screen on; screens never override each other. */
    fun hold(holder: Any, needs: Boolean) = change { st ->
        val holders = if (needs) st.holders + holder else st.holders - holder
        st.copy(holders = holders, userOff = st.userOff && holders.isNotEmpty())
    }

    fun setSetting(on: Boolean) = change { it.copy(settingOn = on) }

    /**
     * Pill tap: on ↔ off for this transfer. Returns true when the setting is off and the caller should turn it
     * back on (the pill's "Off in Settings" action); paused is not interactive.
     */
    fun tap(): Boolean {
        val st = s.value
        return when (_pill.value) {
            PillState.SetOff -> true
            PillState.On, PillState.Off -> {
                change { it.copy(userOff = !st.userOff) }
                false
            }
            PillState.Paused -> false
        }
    }

    private inline fun change(f: (S) -> S) {
        s.update(f)
        val st = s.value
        val active = st.holders.isNotEmpty()
        _pill.value =
            when {
                !st.settingOn -> PillState.SetOff
                !active -> PillState.Paused
                st.userOff -> PillState.Off
                else -> PillState.On
            }
        _screenOn.value = active && st.settingOn && !st.userOff
    }
}
