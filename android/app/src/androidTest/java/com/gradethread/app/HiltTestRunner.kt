package com.gradethread.app

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import dagger.hilt.android.testing.HiltTestApplication

/**
 * US-1395: the Application an instrumented test runs against.
 *
 * NOT [GradeThreadApp]. Its `onCreate` validates config and dies on a missing
 * base URL, starts the sync engine, opens a realtime socket, registers for
 * push and schedules WorkManager — all against whatever backend the test
 * device can reach. A UI test that did that would be an integration test with
 * production, and would fail for reasons that have nothing to do with the code
 * under test.
 *
 * `HiltTestApplication` gives the same object GRAPH with none of that startup.
 */
class HiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(
        cl: ClassLoader?,
        className: String?,
        context: Context?,
    ): Application = super.newApplication(cl, HiltTestApplication::class.java.name, context)
}
