package com.gradethread.app.platform.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Qualifier
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * The IO dispatcher, injected rather than reached for (US-3027).
 *
 * ⚠ WHY THIS EXISTS: `withContext(Dispatchers.IO)` MAKES A TEST LIE. A
 * ViewModel test drives `viewModelScope` through `Dispatchers.setMain(a test
 * dispatcher)` and then calls `advanceUntilIdle()`. That advances the TEST
 * scheduler. A `withContext(Dispatchers.IO)` inside the launch hands the work
 * to a real background pool that the test scheduler knows nothing about, so
 * `advanceUntilIdle()` returns while the coroutine is still suspended and the
 * assertions run against a ViewModel that has not done anything yet.
 *
 * It does not fail loudly. It fails as "the service was never called", which
 * reads exactly like the production code being wrong - and four of
 * ProspectRolesTest's cases sat red on main saying precisely that, describing a
 * bug in code that was, on this point, correct.
 *
 * So the dispatcher is a dependency. A test passes the one it is already
 * driving and `advanceUntilIdle()` means what it says.
 */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class IoDispatcher

@Module
@InstallIn(SingletonComponent::class)
object DispatcherModule {

    @Provides
    @IoDispatcher
    fun provideIoDispatcher(): CoroutineDispatcher = Dispatchers.IO
}
