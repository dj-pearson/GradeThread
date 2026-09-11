package com.gradethread.app.ui

import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import com.gradethread.app.workspace.TeamActions
import com.gradethread.app.workspace.TeamContent
import com.gradethread.app.workspace.TeamMember
import com.gradethread.app.workspace.TeamViewModel
import com.gradethread.app.workspace.WorkspaceInvitationRow
import com.gradethread.app.workspace.WorkspaceRole
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Duration
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * US-2902 AC3: goldens over who can do what in a workspace.
 *
 * ⚠ THE READ-ONLY VIEW IS THE POINT. A member who cannot manage the team sees
 * the same roster with the Invite button, the role menus and the Remove buttons
 * ABSENT - not greyed. Everything about permissions here is what is missing
 * from the layout, and what is missing is exactly what a unit test on the state
 * cannot see. The two views are captured from the same roster, differing only
 * in who is signed in.
 *
 * ⚠ AND `canManage` IS DERIVED FROM THE ROSTER, not passed in. It reads the
 * caller's own row, or OWNER when selfId matches ownerId. So the fixture sets
 * selfId and lets the permission compute, which also proves the derivation - a
 * fixture that set a flag directly would pass over a broken one.
 *
 * ⚠ THE ACCEPT LINK IS OFFERED, NOT MENTIONED. When an invitation is created
 * but its email never sends, that URL is the only way in. A card that stopped
 * rendering strands the invitee with no error anywhere.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel5)
class TeamScreenshotTest {

    private val owner = TeamMember(
        memberId = "u-owner",
        role = WorkspaceRole.OWNER,
        name = "Dj",
        email = "owner@example.invalid",
        isOwner = true,
    )

    private val manager = TeamMember(
        memberId = "u-manager",
        role = WorkspaceRole.LISTING_MANAGER,
        name = "Sam",
        email = "sam@example.invalid",
    )

    private val viewer = TeamMember(
        memberId = "u-viewer",
        role = WorkspaceRole.VIEWER,
        name = null,
        email = "casual@example.invalid",
    )

    private val roster = listOf(owner, manager, viewer)

    /**
     * ⚠ RELATIVE TO NOW, NOT A FIXED DATE, AND THAT IS THE WHOLE POINT
     * (US-3311). `InvitationRow` renders
     * `WorkspaceDate.daysUntil(expiresAt, System.currentTimeMillis())`, and
     * Robolectric does not simulate that clock for app code - it is the real
     * one. The original fixture expired on 2026-09-04, so these seven goldens
     * read "expires in 4 days" on the day they were recorded, counted down
     * afterwards, and were failing on "expires in 0 days" by 2026-09-10.
     * Re-recording would have bought one more day.
     *
     * The half-day is deliberate: `daysUntil` floors, so 4 days plus 12 hours
     * reads 4 whether the run starts a minute or ten hours from now.
     */
    private fun daysFromNow(days: Long, hours: Long = 0): String = DateTimeFormatter.ISO_INSTANT.format(
        Instant.now().plus(Duration.ofDays(days).plusHours(hours)).truncatedTo(ChronoUnit.SECONDS),
    )

    private val invitations = listOf(
        WorkspaceInvitationRow(
            id = "inv1",
            email = "newhire@example.invalid",
            role = "member",
            token = "not-a-real-token",
            createdAt = daysFromNow(-3),
            expiresAt = daysFromNow(4, hours = 12),
        ),
    )

    /** Signed in AS the owner, so canManage computes to true. */
    private val asOwner = TeamViewModel.State(
        loading = false,
        selfId = "u-owner",
        selfEmail = "owner@example.invalid",
        ownerId = "u-owner",
        members = roster,
        invitations = invitations,
    )

    /** The same roster seen by the viewer. Everything managerial disappears. */
    private val asViewer = asOwner.copy(
        selfId = "u-viewer",
        selfEmail = "casual@example.invalid",
    )

    @Test
    fun asOwner_light() = capture("screen-team-owner-light") {
        TeamContent(asOwner, TeamActions())
    }

    @Test
    fun asOwner_dark() = capture("screen-team-owner-dark", dark = true) {
        TeamContent(asOwner, TeamActions())
    }

    /**
     * Same people, same roles, no controls. If this looks like the capture
     * above, the permission gate stopped applying.
     */
    @Test
    fun asViewer_light() = capture("screen-team-viewer-light") {
        TeamContent(asViewer, TeamActions())
    }

    /** Still loading the roster. */
    @Test
    fun loading_light() = capture("screen-team-loading-light") {
        TeamContent(TeamViewModel.State(), TeamActions())
    }

    /** The invite sheet, open on a chosen role. */
    @Test
    fun inviteSheet_light() = capture("screen-team-invite-light") {
        TeamContent(
            asOwner.copy(
                inviteOpen = true,
                inviteEmail = "newhire@example.invalid",
                inviteRole = WorkspaceRole.ADMIN,
            ),
            TeamActions(),
        )
    }

    /**
     * The invitation was created and its email was not delivered. The link is
     * the only way in, so it is on screen rather than described.
     */
    @Test
    fun acceptLinkOffered_dark() = capture("screen-team-acceptlink-dark", dark = true) {
        TeamContent(
            asOwner.copy(acceptUrl = "https://gradethread.com/accept/not-a-real-token"),
            TeamActions(),
        )
    }

    /** One row's action in flight. Only that row is busy. */
    @Test
    fun oneRowBusy_light() = capture("screen-team-busy-light") {
        TeamContent(asOwner.copy(busyKey = "u-manager"), TeamActions())
    }

    /** The failure. */
    @Test
    fun error_dark() = capture("screen-team-error-dark", dark = true) {
        TeamContent(
            asOwner.copy(errorMessage = "Could not reach the server."),
            TeamActions(),
        )
    }

    private fun capture(name: String, dark: Boolean = false, content: @Composable () -> Unit) {
        captureRoboImage("src/test/screenshots/$name.png") {
            ScreenshotTheme(darkTheme = dark) {
                Surface { content() }
            }
        }
    }
}
