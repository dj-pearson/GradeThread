package com.gradethread.app.support

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.gradethread.app.R
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.ui.text
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-1386: the support inbox.
 *
 * Open tickets sort to the top regardless of activity — the server orders by
 * activity alone, which buries the one thing a seller is waiting on the moment
 * support closes a batch of older ones.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupportScreen(onOpenTicket: (String) -> Unit, viewModel: SupportViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    LaunchedEffect(Unit) { viewModel.load() }
    // US-2978: the callback is not among this effect's keys, so the block
    // carries whichever closure existed when the key last changed. Read it
    // through rememberUpdatedState rather than adding it to the keys —
    // restarting on a lambda that changes every recomposition would re-run
    // the effect for no reason.
    val currentOnOpenTicket by rememberUpdatedState(onOpenTicket)
    LaunchedEffect(state.openedTicketId) {
        state.openedTicketId?.let {
            viewModel.onNavigated()
            currentOnOpenTicket(it)
        }
    }

    SupportContent(
        state,
        SupportActions(
            load = viewModel::load,
            openComposer = viewModel::openComposer,
            closeComposer = viewModel::closeComposer,
            setSubject = viewModel::setSubject,
            setBody = viewModel::setBody,
            send = viewModel::send,
            openTicket = onOpenTicket,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class SupportActions(
    val load: () -> Unit = {},
    val openComposer: () -> Unit = {},
    val closeComposer: () -> Unit = {},
    val setSubject: (String) -> Unit = {},
    val setBody: (String) -> Unit = {},
    val send: () -> Unit = {},
    val openTicket: (String) -> Unit = {},
)

/**
 * Support with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ THE VALIDATION IS PER FIELD AND ONLY APPEARS ONCE TYPING STARTS.
 * subjectError and bodyError are null while a field is empty, so a seller who
 * has not touched the form is not told off for it - and canSend is false
 * regardless. A form that showed both errors on open would read as broken
 * before anyone did anything.
 *
 * ⚠ AND AN EMPTY TICKET LIST IS THE ORDINARY CASE. Most people never open a
 * ticket; that state must not look like a failed load, which is the state
 * directly beside it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupportContent(state: SupportViewModel.State, actions: SupportActions, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(Spacing.md)) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                stringResource(R.string.support_title),
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.weight(1f),
            )
            BrandPrimaryButton(text = stringResource(R.string.support_new_request)) {
                actions.openComposer()
            }
        }

        when {
            state.loading && state.tickets.isEmpty() -> Row(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }

            state.loadError != null -> Column(Modifier.fillMaxWidth().cardStyle()) {
                Text(state.loadError!!, style = MaterialTheme.typography.bodyMedium)
                BrandSecondaryButton(
                    text = stringResource(R.string.common_try_again),
                    modifier = Modifier.padding(top = Spacing.sm),
                ) { actions.load() }
            }

            state.isEmpty -> Text(
                stringResource(Support.EMPTY),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.cardStyle(),
            )

            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                items(state.tickets, key = { it.id }) { ticket ->
                    TicketRow(ticket) { actions.openTicket(ticket.id) }
                }
            }
        }
    }

    if (state.composerOpen) {
        ModalBottomSheet(onDismissRequest = actions.closeComposer) {
            Composer(state, actions)
        }
    }
}

@Composable
private fun TicketRow(ticket: SupportTicket, onClick: () -> Unit) {
    val subject = ticket.subject.ifBlank { stringResource(R.string.support_fallback_subject) }
    val spoken = "$subject. ${Support.statusLabel(ticket.status)}."
    Column(
        Modifier
            .fillMaxWidth()
            .cardStyle(flush = true)
            .clickable(onClick = onClick)
            .padding(Spacing.md)
            .semantics { contentDescription = spoken },
    ) {
        Text(
            subject,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Medium,
        )
        Text(
            Support.statusLabel(ticket.status).text(),
            style = MaterialTheme.typography.bodySmall,
            color = if (Support.isOpen(ticket)) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.onSurfaceVariant
            },
        )
    }
}

@Composable
private fun Composer(state: SupportViewModel.State, actions: SupportActions) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.md)
            .padding(bottom = Spacing.xl),
    ) {
        Text(
            stringResource(R.string.support_compose_title),
            style = MaterialTheme.typography.titleLarge,
        )
        OutlinedTextField(
            value = state.subject,
            onValueChange = actions.setSubject,
            label = { Text(stringResource(R.string.support_subject)) },
            singleLine = true,
            isError = state.subjectError != null,
            supportingText = state.subjectError?.let { { Text(it.text()) } },
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
        )
        OutlinedTextField(
            value = state.body,
            onValueChange = actions.setBody,
            label = { Text(stringResource(R.string.support_body_label)) },
            minLines = 4,
            isError = state.bodyError != null,
            // The counter is the point: the server slices past its cap, so
            // without this someone loses their last paragraph in silence.
            supportingText = {
                Text(
                    state.bodyError?.text()
                        ?: "${state.body.length} / ${Support.MAX_BODY}",
                )
            },
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
        )
        state.sendError?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = Spacing.xs),
            )
        }
        BrandPrimaryButton(
            text = stringResource(
                if (state.sending) R.string.common_sending else R.string.common_send,
            ),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
            enabled = state.canSend,
        ) { actions.send() }
    }
}
