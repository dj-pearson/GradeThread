package com.gradethread.app.support

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
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
 * US-1386: one support thread.
 *
 * Where a `support.reply` push lands. The ticket id comes in on the deep link,
 * so this screen has to survive being opened cold, signed in as an account that
 * may no longer own that ticket — which is why the 404 has its own copy rather
 * than a spinner that never resolves.
 */
@Composable
fun SupportThreadScreen(ticketId: String, onBack: () -> Unit, viewModel: SupportThreadViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()

    LaunchedEffect(ticketId) { viewModel.load(ticketId) }

    SupportThreadContent(
        state,
        SupportThreadActions(
            retry = { viewModel.load(ticketId) },
            setReply = viewModel::setReply,
            send = { viewModel.send(ticketId) },
            back = onBack,
        ),
    )
}

/** Everything this screen can be asked to do (US-2902 AC3). */
@Immutable
data class SupportThreadActions(
    val retry: () -> Unit = {},
    val setReply: (String) -> Unit = {},
    val send: () -> Unit = {},
    val back: () -> Unit = {},
)

/**
 * One support conversation, with no ViewModel attached (US-2902 AC3).
 *
 * ⚠ REPLYING TO A RESOLVED TICKET REOPENS IT, and reopenNotice is the only
 * place that is said. A seller adding "thanks, all sorted" to a closed ticket
 * would put it back in the queue without that line, and neither they nor
 * support would know why it came back.
 *
 * ⚠ AND WHOSE MESSAGE IS WHOSE IS PURELY VISUAL. fromMe is author == "you";
 * everything else about the two bubbles is layout. A thread that stopped
 * distinguishing them reads as support saying what the seller said.
 */
@Composable
fun SupportThreadContent(
    state: SupportThreadViewModel.State,
    actions: SupportThreadActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize().padding(Spacing.md)) {
        when {
            state.loading && state.thread == null -> Row(
                Modifier.fillMaxWidth().padding(Spacing.xl),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }

            state.loadError != null -> Column(Modifier.fillMaxWidth().cardStyle()) {
                Text(state.loadError!!, style = MaterialTheme.typography.bodyMedium)
                Row(Modifier.padding(top = Spacing.sm)) {
                    BrandSecondaryButton(text = stringResource(R.string.common_back)) { actions.back() }
                    BrandSecondaryButton(
                        text = stringResource(R.string.common_try_again),
                        modifier = Modifier.padding(start = Spacing.xs),
                    ) { actions.retry() }
                }
            }

            state.thread != null -> {
                val thread = state.thread!!
                Text(
                    thread.ticket.subject.ifBlank {
                        stringResource(R.string.support_fallback_subject)
                    },
                    style = MaterialTheme.typography.headlineSmall,
                )
                Text(
                    Support.statusLabel(thread.ticket.status).text(),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = Spacing.sm),
                )

                LazyColumn(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(Spacing.sm),
                ) {
                    items(thread.messages, key = { it.id }) { MessageBubble(it) }
                }

                state.reopenNotice?.let {
                    // Said BEFORE they send. Someone adding "thanks, that
                    // worked" deserves to know it goes back in the queue.
                    Text(
                        stringResource(it),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = Spacing.xs),
                    )
                }
                OutlinedTextField(
                    value = state.reply,
                    onValueChange = actions.setReply,
                    label = { Text(stringResource(R.string.support_reply_label)) },
                    minLines = 2,
                    supportingText = {
                        Text(state.sendError ?: "${state.reply.length} / ${Support.MAX_BODY}")
                    },
                    isError = state.sendError != null,
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
                )
                BrandPrimaryButton(
                    text = stringResource(
                        if (state.sending) R.string.common_sending else R.string.support_send_reply,
                    ),
                    modifier = Modifier.fillMaxWidth().padding(top = Spacing.xs),
                    enabled = state.canSend,
                ) { actions.send() }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: SupportMessage) {
    // Who said it, first: a screen-reader user otherwise hears a wall of
    // replies with no way to tell theirs from support's.
    val spoken = stringResource(
        if (message.fromMe) R.string.support_said_you else R.string.support_said_support,
        message.body,
    )
    Column(
        Modifier
            .fillMaxWidth()
            .cardStyle()
            // Who said it, first: a screen reader user otherwise hears a wall
            // of replies with no way to tell theirs from support's.
            .semantics { contentDescription = spoken },
    ) {
        Text(
            stringResource(
                if (message.fromMe) R.string.support_author_you else R.string.support_author_support,
            ),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium,
            color = if (message.fromMe) {
                MaterialTheme.colorScheme.onSurfaceVariant
            } else {
                MaterialTheme.colorScheme.primary
            },
        )
        Text(message.body, style = MaterialTheme.typography.bodyMedium)
    }
}
