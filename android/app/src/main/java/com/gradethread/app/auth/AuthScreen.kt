package com.gradethread.app.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.compose.foundation.text.KeyboardOptions
import com.gradethread.app.R
import com.gradethread.app.ui.TestTags
import com.gradethread.app.ui.theme.BrandPrimaryButton
import com.gradethread.app.ui.theme.BrandSecondaryButton
import com.gradethread.app.ui.theme.Spacing

/**
 * US-2369: sign in, or create an account.
 *
 * This did not exist. `MainActivity` composed the shell unconditionally, so the
 * app was unusable by anyone not already holding a session — and every piece of
 * auth plumbing underneath (PKCE, the classified errors, the OAuth callback)
 * had no surface to reach it from.
 */
@Composable
fun AuthScreen(viewModel: AuthViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsState()
    // US-2792: the Custom Tab needs an Activity context to launch from. It is
    // bound HERE so AuthContent needs no Context and stays renderable from a
    // screenshot test.
    val context = LocalContext.current
    AuthContent(
        state = state,
        actions = AuthActions(
            setEmail = viewModel::setEmail,
            setPassword = viewModel::setPassword,
            setFullName = viewModel::setFullName,
            setCaptcha = viewModel::setCaptcha,
            dismissNotice = viewModel::dismissNotice,
            toggleMode = viewModel::toggleMode,
            submit = viewModel::submit,
            resendConfirmation = viewModel::resendConfirmation,
            resetPassword = viewModel::resetPassword,
            signInWithProvider = { viewModel.signInWithProvider(context, it) },
        ),
    )
}

/**
 * Everything AuthScreen can do, in one parameter (US-2902 AC3).
 *
 * Ten callbacks passed individually is a signature nobody reads and a screenshot
 * test nobody writes. Bundled, the stateless half below takes exactly two
 * arguments and can be rendered from a golden with no Hilt graph, no ViewModel
 * and no Context.
 */
@Immutable
data class AuthActions(
    val setEmail: (String) -> Unit = {},
    val setPassword: (String) -> Unit = {},
    val setFullName: (String) -> Unit = {},
    val setCaptcha: (TurnstileResult) -> Unit = {},
    val dismissNotice: () -> Unit = {},
    val toggleMode: () -> Unit = {},
    val submit: () -> Unit = {},
    val resendConfirmation: () -> Unit = {},
    val resetPassword: () -> Unit = {},
    val signInWithProvider: (OAuthSignIn.Provider) -> Unit = {},
)

/**
 * The sign-in screen with no ViewModel attached.
 *
 * ⚠ THIS IS THE SCREEN US-3003's DEFECT LIVED ON. The headline was black on the
 * navy window in dark mode, because setContent had no Surface and
 * LocalContentColor defaults to black - invisible, on the first screen every
 * user sees, and found only by launching the app on a device. A golden over
 * this function is what would have caught it in CI, which is the whole argument
 * of US-2902 AC3: 49 of 52 screens take a ViewModel and cannot be captured.
 *
 * The layout below is UNCHANGED from the version that lived inside AuthScreen -
 * only the callback references are rebound - so the extraction cannot itself
 * have altered what a golden records.
 */
@Composable
fun AuthContent(state: AuthViewModel.State, actions: AuthActions, modifier: Modifier = Modifier) {
    var passwordVisible by remember { mutableStateOf(false) }

    Column(
        // The default is Modifier, so this chain is identical to the one that
        // lived here before the extraction - the goldens recorded against it
        // cannot have moved.
        modifier
            .testTag(TestTags.Auth.SCREEN)
            .fillMaxSize()
            // US-2891: API 36 makes edge-to-edge mandatory - the opt-out that
            // still existed at 35 is gone - and MainActivity composes this
            // screen directly, with no Scaffold above it to apply the
            // system-bar insets. Without this the headline drew over the
            // status-bar clock. safeDrawing rather than systemBars so a display
            // cutout is covered by the same rule, and it sits OUTSIDE the
            // scroll so the viewport itself is inset - inside, the first line
            // would still start under the bar and merely be scrollable clear.
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(Spacing.lg),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            stringResource(
                if (state.isSignUp) R.string.auth_create_account else R.string.auth_sign_in,
            ),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text(
            stringResource(R.string.auth_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        if (state.busy) LinearProgressIndicator(Modifier.fillMaxWidth())

        if (state.isSignUp) {
            OutlinedTextField(
                value = state.fullName,
                onValueChange = actions.setFullName,
                label = { Text(stringResource(R.string.auth_name)) },
                singleLine = true,
                enabled = !state.busy,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        OutlinedTextField(
            value = state.email,
            onValueChange = actions.setEmail,
            label = { Text(stringResource(R.string.auth_email)) },
            singleLine = true,
            enabled = !state.busy,
            isError = state.emailError != null,
            supportingText = state.emailError?.let { { Text(it) } },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next,
            ),
            modifier = Modifier.testTag(TestTags.Auth.EMAIL).fillMaxWidth(),
        )

        OutlinedTextField(
            value = state.password,
            onValueChange = actions.setPassword,
            label = { Text(stringResource(R.string.auth_password)) },
            singleLine = true,
            enabled = !state.busy,
            isError = state.passwordError != null,
            // The rules are shown BEFORE they are broken on sign-up: finding
            // out the requirement only after a rejection is how people end up
            // trying four passwords.
            supportingText = {
                Text(
                    state.passwordError
                        ?: if (state.isSignUp) AuthFormRules.PASSWORD_HINT else "",
                )
            },
            visualTransformation = if (passwordVisible) {
                VisualTransformation.None
            } else {
                PasswordVisualTransformation()
            },
            trailingIcon = {
                TextButton(onClick = { passwordVisible = !passwordVisible }) {
                    Text(
                        stringResource(
                            if (passwordVisible) R.string.auth_hide else R.string.auth_show,
                        ),
                    )
                }
            },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done,
            ),
            modifier = Modifier.testTag(TestTags.Auth.PASSWORD).fillMaxWidth(),
        )

        state.errorMessage?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
            )
            // The right button under the message. "That didn't work" with no
            // next step is where people give up.
            when (state.recovery) {
                AuthFormRules.Recovery.RESEND_CONFIRMATION -> BrandSecondaryButton(
                    text = stringResource(R.string.auth_resend_confirmation),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.busy,
                ) { actions.resendConfirmation() }

                AuthFormRules.Recovery.RESET_PASSWORD -> BrandSecondaryButton(
                    text = stringResource(R.string.auth_reset_password),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.busy,
                ) { actions.resetPassword() }

                AuthFormRules.Recovery.SWITCH_TO_SIGN_IN -> BrandSecondaryButton(
                    text = stringResource(R.string.auth_sign_in),
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.busy,
                ) { actions.toggleMode() }

                AuthFormRules.Recovery.NONE -> Unit
            }
        }

        state.notice?.let { notice ->
            Text(notice, style = MaterialTheme.typography.bodyMedium)
            TextButton(onClick = actions.dismissNotice) {
                Text(stringResource(R.string.common_ok))
            }
        }

        // US-2792: bot protection on signup, which web and iOS both have and
        // Android did not. TurnstileChallenge and its XSS-escaping test have
        // existed since US-1312 with nothing rendering either.
        //
        // SIGNUP ONLY: sign-in is a credential check against an account that
        // already exists, and what this stops is bulk account CREATION.
        //
        // Invisible without a site key - the composable reports NotConfigured
        // and builds no WebView at all, so a dev or CI build behaves exactly as
        // it did before this existed.
        ProviderSignIn(onProvider = { actions.signInWithProvider(it) })

        SignUpCaptcha(state.isSignUp, actions.setCaptcha)

        BrandPrimaryButton(
            text = stringResource(
                when {
                    state.busy -> R.string.auth_working
                    state.isSignUp -> R.string.auth_create_account
                    else -> R.string.auth_sign_in
                },
            ),
            modifier = Modifier
                .testTag(TestTags.Auth.SUBMIT)
                .fillMaxWidth()
                .padding(top = Spacing.sm),
            enabled = state.canSubmit,
        ) { actions.submit() }

        TextButton(
            onClick = actions.toggleMode,
            enabled = !state.busy,
            modifier = Modifier.testTag(TestTags.Auth.TOGGLE).fillMaxWidth(),
        ) {
            Text(
                stringResource(
                    if (state.isSignUp) R.string.auth_have_account else R.string.auth_need_account,
                ),
            )
        }
    }
}

/**
 * US-2792: the signup-only bot challenge.
 *
 * A composable rather than an `if` inside AuthScreen because that screen was
 * already AT detekt's cyclomatic-complexity ceiling of 20 - adding one branch
 * to it failed the build. Holding the condition here keeps the decision next to
 * the thing it decides and gives AuthScreen a plain call.
 */
@Composable
private fun SignUpCaptcha(isSignUp: Boolean, onResult: (TurnstileResult) -> Unit) {
    if (!isSignUp) return
    TurnstileChallenge(onResult = onResult)
}

/**
 * US-2792: the provider entry points.
 *
 * US-1311 built OAuthSignIn.launch() over Chrome Custom Tabs and wired the
 * RETURN leg properly — AuthCallbackActivity is a manifest App Link that
 * completes the PKCE exchange. Nothing ever called launch(), so half a feature
 * shipped and the half that shipped is the half nobody looks at.
 *
 * FILTERED BY isAvailable, whose own doc says "whether the provider's entry
 * point should render at all" — the seam was designed for this. Google stays
 * hidden until AppConfig.googleSignInEnabled is turned on, which waits on the
 * provider being configured in the self-hosted GoTrue. Apple is available
 * today, so this ships a working button rather than a disabled one.
 *
 * Renders nothing when no provider is available, so the row cannot become an
 * empty gap with a divider above it.
 */
@Composable
private fun ProviderSignIn(onProvider: (OAuthSignIn.Provider) -> Unit) {
    val available = OAuthSignIn.Provider.entries.filter(OAuthSignIn::isAvailable)
    if (available.isEmpty()) return

    available.forEach { provider ->
        BrandSecondaryButton(
            text = stringResource(
                when (provider) {
                    OAuthSignIn.Provider.GOOGLE -> R.string.auth_continue_google
                    OAuthSignIn.Provider.APPLE -> R.string.auth_continue_apple
                },
            ),
            modifier = Modifier.fillMaxWidth().padding(top = Spacing.sm),
        ) { onProvider(provider) }
    }
}
