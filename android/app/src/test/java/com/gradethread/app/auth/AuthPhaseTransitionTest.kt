package com.gradethread.app.auth

import io.github.jan.supabase.createSupabaseClient
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * US-1310: the phase-transition rules — most importantly the 1h-boundary
 * rule: a REFRESH FAILURE holds the current phase instead of signing the
 * user out (the spurious-"session expired" incident class from iOS).
 */
class AuthPhaseTransitionTest {

    private fun repo() = AuthRepository(
        createSupabaseClient(
            supabaseUrl = "https://example.test",
            supabaseKey = "test-key",
        ) {},
    )

    @Test
    fun refreshFailure_holdsTheCurrentPhase() {
        val repo = repo()
        val signedIn = AuthRepository.Phase.SignedIn("u1", "a@b.co")
        assertEquals(
            signedIn,
            repo.nextPhase(signedIn, AuthRepository.SessionEvent.REFRESH_FAILURE),
        )
        assertEquals(
            AuthRepository.Phase.SignedOut,
            repo.nextPhase(
                AuthRepository.Phase.SignedOut,
                AuthRepository.SessionEvent.REFRESH_FAILURE,
            ),
        )
    }

    @Test
    fun notAuthenticated_isTheDefinitiveSignOut() {
        val repo = repo()
        assertEquals(
            AuthRepository.Phase.SignedOut,
            repo.nextPhase(
                AuthRepository.Phase.SignedIn("u1", null),
                AuthRepository.SessionEvent.NOT_AUTHENTICATED,
            ),
        )
    }

    @Test
    fun initializing_readsLoading() {
        val repo = repo()
        assertEquals(
            AuthRepository.Phase.Loading,
            repo.nextPhase(
                AuthRepository.Phase.SignedOut,
                AuthRepository.SessionEvent.INITIALIZING,
            ),
        )
    }
}
