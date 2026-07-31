package com.gradethread.app.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * US-1380: the catch-up redraw.
 *
 * When a publish lands inside the coalescing window the snapshot is stored but
 * the widget is not redrawn. Without this worker that change would sit
 * invisible until the next sync happened to fall outside the window — which,
 * for a seller who syncs once and puts the phone down, could be half an hour.
 * KEEP, so a flurry of held publishes schedules exactly one redraw.
 */
class WidgetReloadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        WidgetPublisher.reload(applicationContext)
        return Result.success()
    }

    companion object {
        const val WORK_NAME = "widget-reload"

        fun enqueue(context: Context, delayMs: Long) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME,
                ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<WidgetReloadWorker>()
                    .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    .build(),
            )
        }
    }
}
