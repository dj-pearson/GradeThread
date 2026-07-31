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
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
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
fun SupportScreen(
    onOpenTicket: (String) -> Unit,
    viewModel: SupportViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsState()

    LaunchedEffect(Unit) { viewModel.load() }
    LaunchedEffect(state.openedTicketId) {
        state.openedTicketId?.let {
            viewModel.onNavigated()
            onOpenTicket(it)
        }
    }

    Column(Modifier.fillMaxSize().padding(Spacing.md)) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Support",
                style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.weight(1f),
            )
            BrandPrimaryButton(text = "New request") { viewModel.openComposer() }
        }

        when {
            state.loading && state.tickets.isEmpty() -> Row(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }

            state.loadError != null -> Column(Modifier.fillMaxWidth().cardStyle()) {
                Text(state.loadError!!, style = MaterialTheme.typography.bodyMedium)
                BrandSecondaryButton(
                    text = "Try again",
                    modifier = Modifier.padding(top = Spacing.sm),
                ) { viewModel.load() }
            }

            state.isEmpty -> Text(
                Support.EMPTY,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.cardStyle(),
            )

            else -> LazyColumn(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                items(state.tickets, key = { it.id }) { ticket ->
                    TicketRow(ticket) { onOpenTicket(ticket.id) }
                }
            }
        }
    }

    if (state.composerOpen) {
        ModalBottomSheet(onDismissRequest = viewModel::closeComposer) {
            Composer(state, viewModel)
        }
    }
}

@Composable
private fun TicketRow(ticket: SupportTicket, onClick: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .cardStyle(flush = true)
            .clickable(onClick = onClick)
            .padding(Spacing.md)
            .semantics {
                contentDescription =
                    "${ticket.subject}. ${Support.statusLabel(ticket.status)}."
            },
    ) {
        Text(
            ticket.subject.ifBlank { "Support request" },
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Medium,
        )
        Text(
            Support.statusLabel(ticket.status),
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
private fun Composer(state: SupportViewModel.State, viewModel: SupportViewModel) {
    Column(
        Modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.md)
            .padding(bottom = Spacing.xl),
    ) {
        Text("Open a request", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(
            value = state.subject,
            onValueChange = viewModel::setSubject,
            label = { Text("Subject") },
            singleLine = true,
            isError = state.subjectError != null,
            supportingText = state.subjectError?.let { { Text(it) } },
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
        )
        OutlinedTextField(
            value = state.body,
            onValueChange = viewModel::setBody,
            label = { Text("What's happening?") },
            minLines = 4,
            isError = state.bodyError != null,
            // The counter is the point: the server slices past its cap, so
            // without this someone loses their last paragraph in silence.
            supportingText = {
                Text(state.bodyError ?: "${state.body.length} / ${Support.MAX_BODY}")
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
            text = if (state.sending) "Sending…" else "Send",
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.md),
            enabled = state.canSend,
        ) { viewModel.send() }
    }
}
