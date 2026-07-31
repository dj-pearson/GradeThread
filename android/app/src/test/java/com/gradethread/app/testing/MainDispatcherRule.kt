package com.gradethread.app.testing

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.rules.TestWatcher
import org.junit.runner.Description

/**
 * Swaps `Dispatchers.Main` for a test dispatcher.
 *
 * `viewModelScope` runs on `Dispatchers.Main.immediate`, which does not exist on
 * a plain JVM test JVM — without this, every ViewModel test fails at the first
 * `launch` with "Module with the Main dispatcher had failed to initialize",
 * which reads like a bug in the code under test rather than in the harness.
 *
 * Pass [dispatcher] to `runTest` so the test body and the ViewModel share one
 * scheduler; otherwise `advanceUntilIdle()` advances a clock nothing is on.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class MainDispatcherRule(
    val dispatcher: TestDispatcher = StandardTestDispatcher(),
) : TestWatcher() {

    override fun starting(description: Description) {
        Dispatchers.setMain(dispatcher)
    }

    override fun finished(description: Description) {
        Dispatchers.resetMain()
    }
}
