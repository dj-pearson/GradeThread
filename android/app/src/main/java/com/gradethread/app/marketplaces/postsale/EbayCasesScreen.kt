package com.gradethread.app.marketplaces.postsale

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.hilt.navigation.compose.hiltViewModel
import com.gradethread.app.R
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing
import com.gradethread.app.ui.theme.cardStyle

/**
 * US-2409: the eBay cases with a clock on them.
 *
 * A closed case is never shown with its action buttons. eBay's own states are
 * not an enum anyone can rely on, so the rule (see [EbayCases]) defaults to
 * OPEN — a case wrongly shown as open costs the seller a glance, and one
 * wrongly hidden costs them the case.
 */
@Composable
fun EbayCasesScreen(onClose: () -> Unit = {}, viewModel: EbayCasesViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    val context = LocalContext.current
    var contesting by remember { mutableStateOf<EbayPaymentDispute?>(null) }
    var evidenceFor by remember { mutableStateOf<String?>(null) }

    val picker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia(),
    ) { uri ->
        val disputeId = evidenceFor
        evidenceFor = null
        if (uri != null && disputeId != null) {
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            }.getOrNull()
            if (bytes != null) viewModel.addEvidence(disputeId, bytes, "evidence.jpg")
        }
    }

    LaunchedEffect(Unit) { viewModel.load() }

    Column(
        Modifier.fillMaxSize().padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(
            stringResource(R.string.cases_title),
            style = MaterialTheme.typography.titleLarge,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            for (tab in EbayCasesViewModel.Tab.entries) {
                FilterChip(
                    selected = state.tab == tab,
                    onClick = { viewModel.selectTab(tab) },
                    label = { Text(tabLabel(tab, state.openCount(tab))) },
                )
            }
        }

        state.errorMessage?.let { message ->
            Column(Modifier.fillMaxWidth().cardStyle()) {
                Text(
                    message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
                Row {
                    // The evidence upload is two server calls and is not
                    // idempotent, so it is never retried behind the seller's
                    // back — only here, once, knowingly.
                    if (state.pendingEvidence != null) {
                        TextButton(onClick = viewModel::retryEvidence) {
                            Text(stringResource(R.string.common_try_again))
                        }
                        TextButton(onClick = viewModel::dropPendingEvidence) {
                            Text(stringResource(R.string.cases_give_up))
                        }
                    }
                    TextButton(onClick = viewModel::dismissMessages) {
                        Text(stringResource(R.string.common_dismiss))
                    }
                }
            }
        }

        if (state.evidenceSent) {
            Text(
                stringResource(R.string.cases_evidence_sent),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.fillMaxWidth().cardStyle(),
            )
        }

        if (state.loading) {
            Row(
                Modifier.fillMaxWidth().padding(Spacing.md),
                horizontalArrangement = Arrangement.Center,
            ) { CircularProgressIndicator() }
        }

        val closedCount = when (state.tab) {
            EbayCasesViewModel.Tab.DISPUTES -> state.closedDisputes.size
            EbayCasesViewModel.Tab.RETURNS -> state.closedReturns.size
            EbayCasesViewModel.Tab.CANCELLATIONS -> state.closedCancellations.size
        }

        LazyColumn(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            when (state.tab) {
                EbayCasesViewModel.Tab.DISPUTES -> {
                    items(state.openDisputes, key = { it.paymentDisputeId }) { dispute ->
                        DisputeCard(
                            dispute = dispute,
                            state = state,
                            viewModel = viewModel,
                            closed = false,
                            onContest = { contesting = dispute },
                            onEvidence = {
                                evidenceFor = dispute.paymentDisputeId
                                picker.launch(
                                    PickVisualMediaRequest(
                                        ActivityResultContracts.PickVisualMedia.ImageOnly,
                                    ),
                                )
                            },
                        )
                    }
                    if (state.showClosed) {
                        items(state.closedDisputes, key = { it.paymentDisputeId }) { dispute ->
                            DisputeCard(dispute, state, viewModel, closed = true, onContest = {}, onEvidence = {})
                        }
                    }
                }

                EbayCasesViewModel.Tab.RETURNS -> {
                    items(state.openReturns, key = { it.returnId }) { case ->
                        ReturnCard(case, state, viewModel, closed = false)
                    }
                    if (state.showClosed) {
                        items(state.closedReturns, key = { it.returnId }) { case ->
                            ReturnCard(case, state, viewModel, closed = true)
                        }
                    }
                }

                EbayCasesViewModel.Tab.CANCELLATIONS -> {
                    items(state.openCancellations, key = { it.cancelId }) { case ->
                        CancellationCard(case, state, viewModel, closed = false)
                    }
                    if (state.showClosed) {
                        items(state.closedCancellations, key = { it.cancelId }) { case ->
                            CancellationCard(case, state, viewModel, closed = true)
                        }
                    }
                }
            }

            if (state.openCount(state.tab) == 0 && !state.loading) {
                item {
                    Text(
                        stringResource(R.string.cases_nothing_open),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().cardStyle(),
                    )
                }
            }
        }

        if (closedCount > 0) {
            TextButton(onClick = viewModel::toggleClosed) {
                Text(
                    stringResource(
                        if (state.showClosed) R.string.cases_hide_closed else R.string.cases_show_closed,
                        closedCount,
                    ),
                )
            }
        }

        BrandSecondaryButton(
            text = stringResource(R.string.common_back),
            modifier = Modifier.fillMaxWidth(),
        ) { onClose() }
    }

    contesting?.let { dispute ->
        ContestDialog(
            busy = state.isBusy(dispute.paymentDisputeId),
            onDismiss = { contesting = null },
            onContest = { note ->
                viewModel.contestDispute(dispute, note)
                contesting = null
            },
        )
    }
}

@Composable
private fun tabLabel(tab: EbayCasesViewModel.Tab, openCount: Int): String {
    val name = stringResource(
        when (tab) {
            EbayCasesViewModel.Tab.DISPUTES -> R.string.cases_tab_disputes
            EbayCasesViewModel.Tab.RETURNS -> R.string.cases_tab_returns
            EbayCasesViewModel.Tab.CANCELLATIONS -> R.string.cases_tab_cancellations
        },
    )
    return if (openCount == 0) name else stringResource(R.string.cases_tab_count, name, openCount)
}

@Composable
private fun DisputeCard(
    dispute: EbayPaymentDispute,
    state: EbayCasesViewModel.State,
    viewModel: EbayCasesViewModel,
    closed: Boolean,
    onContest: () -> Unit,
    onEvidence: () -> Unit,
) {
    val now = System.currentTimeMillis()
    val days = EbayCases.daysUntil(dispute.respondByDate, now)
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            dispute.reason ?: stringResource(R.string.cases_dispute),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        dispute.status?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        // The deadline is the whole reason this screen exists on a phone: eBay
        // decides the case against the seller when it runs out.
        if (days != null) {
            Text(
                if (days < 0) {
                    stringResource(R.string.cases_overdue)
                } else {
                    pluralStringResource(R.plurals.cases_respond_in, days.toInt(), days.toInt())
                },
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.SemiBold,
                color = if (days < 0) {
                    MaterialTheme.colorScheme.error
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
            )
        }
        if (!closed) {
            Row {
                TextButton(
                    onClick = onEvidence,
                    enabled = !state.isBusy(dispute.paymentDisputeId),
                ) { Text(stringResource(R.string.cases_send_proof)) }
                TextButton(
                    onClick = onContest,
                    enabled = !state.isBusy(dispute.paymentDisputeId),
                ) { Text(stringResource(R.string.cases_contest)) }
                TextButton(
                    onClick = { viewModel.acceptDispute(dispute) },
                    enabled = !state.isBusy(dispute.paymentDisputeId),
                ) {
                    Text(
                        stringResource(R.string.cases_accept_refund),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun ReturnCard(
    case: EbayReturn,
    state: EbayCasesViewModel.State,
    viewModel: EbayCasesViewModel,
    closed: Boolean,
) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            case.reason ?: stringResource(R.string.cases_return),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        Text(
            case.state.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!closed) {
            Row {
                TextButton(
                    onClick = { viewModel.decideReturn(case, "decline") },
                    enabled = !state.isBusy(case.returnId),
                ) { Text(stringResource(R.string.cases_decline)) }
                TextButton(
                    onClick = { viewModel.decideReturn(case, "approve") },
                    enabled = !state.isBusy(case.returnId),
                ) { Text(stringResource(R.string.cases_approve)) }
                TextButton(
                    onClick = { viewModel.refundReturn(case) },
                    enabled = !state.isBusy(case.returnId),
                ) {
                    Text(
                        stringResource(R.string.cases_refund),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun CancellationCard(
    case: EbayCancellation,
    state: EbayCasesViewModel.State,
    viewModel: EbayCasesViewModel,
    closed: Boolean,
) {
    Column(Modifier.fillMaxWidth().cardStyle()) {
        Text(
            case.reason ?: stringResource(R.string.cases_cancellation),
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
        )
        Text(
            case.state.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (!closed) {
            Row {
                TextButton(
                    onClick = { viewModel.decideCancellation(case, "reject") },
                    enabled = !state.isBusy(case.cancelId),
                ) { Text(stringResource(R.string.cases_reject)) }
                TextButton(
                    onClick = { viewModel.decideCancellation(case, "approve") },
                    enabled = !state.isBusy(case.cancelId),
                ) {
                    Text(
                        stringResource(R.string.cases_approve_cancel),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}

@Composable
private fun ContestDialog(busy: Boolean, onDismiss: () -> Unit, onContest: (String) -> Unit) {
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.cases_contest)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Text(
                    stringResource(R.string.cases_contest_help),
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = note,
                    onValueChange = { note = it },
                    label = { Text(stringResource(R.string.cases_contest_note)) },
                    minLines = 3,
                )
            }
        },
        confirmButton = {
            TextButton(enabled = !busy, onClick = { onContest(note) }) {
                Text(stringResource(R.string.cases_contest))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cases_cancel)) }
        },
    )
}
