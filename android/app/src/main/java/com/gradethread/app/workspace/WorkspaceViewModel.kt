package com.gradethread.app.workspace

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.gradethread.app.auth.AuthRepository
import com.gradethread.app.platform.workspace.WorkspaceScope
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * US-1388: the workspace switcher.
 *
 * Loads the list, drops a selection that no longer exists, and performs the
 * switch through [WorkspaceSwitcher] so the cache reset, the queue flush and
 * the re-pull all happen in the order [com.gradethread.app.sync.SessionScope]
 * documents.
 */
@HiltViewModel
class WorkspaceViewModel @Inject constructor(
    private val reader: WorkspaceReading,
    private val switcher: WorkspaceSwitcher,
    private val auth: AuthRepository,
) : ViewModel() {

    data class State(
        val loading: Boolean = false,
        val selfId: String? = null,
        val workspaces: List<WorkspaceSummary> = emptyList(),
        val activeOwnerId: String? = null,
        val switching: Boolean = false,
        val pickerOpen: Boolean = false,
        val notice: String? = null,
    ) {
        val active: WorkspaceSummary?
            get() = selfId?.let { Workspaces.active(workspaces, activeOwnerId, it) }

        val hasChoice: Boolean get() = Workspaces.hasChoice(workspaces)

        val subtitle: String get() = Workspaces.subtitle(active)
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            auth.phase.collect { phase ->
                val id = (phase as? AuthRepository.Phase.SignedIn)?.userId
                _state.value = _state.value.copy(selfId = id)
                if (id != null) load()
            }
        }
        viewModelScope.launch {
            WorkspaceScope.events.collect { event ->
                _state.value = _state.value.copy(activeOwnerId = WorkspaceScope.activeOwnerId)
                // US-794: an involuntary switch has to be said out loud, or the
                // seller sees their shared workspace's data vanish and assumes
                // the app lost it.
                if (event is WorkspaceScope.Event.AccessRevoked) {
                    _state.value = _state.value.copy(notice = Workspaces.ACCESS_REVOKED)
                }
            }
        }
    }

    fun load() {
        val selfId = _state.value.selfId ?: return
        if (_state.value.loading) return
        _state.value = _state.value.copy(loading = true)
        viewModelScope.launch {
            val list = reader.list(selfId)
            // A membership revoked while the app was closed leaves an owner id
            // in preferences that every request then sends as a header. This
            // load is where it gets dropped.
            if (Workspaces.isStale(WorkspaceScope.activeOwnerId, list)) {
                WorkspaceScope.clear()
            }
            _state.value = _state.value.copy(
                loading = false,
                workspaces = list,
                activeOwnerId = WorkspaceScope.activeOwnerId,
            )
        }
    }

    fun openPicker() {
        _state.value = _state.value.copy(pickerOpen = true)
    }

    fun closePicker() {
        _state.value = _state.value.copy(pickerOpen = false)
    }

    fun dismissNotice() {
        _state.value = _state.value.copy(notice = null)
    }

    fun switchTo(workspace: WorkspaceSummary) {
        if (_state.value.switching) return
        _state.value = _state.value.copy(switching = true, pickerOpen = false)
        viewModelScope.launch {
            switcher.switchTo(workspace.ownerId)
            _state.value = _state.value.copy(
                switching = false,
                activeOwnerId = WorkspaceScope.activeOwnerId,
            )
        }
    }
}
