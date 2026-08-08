package com.gradethread.app.platform.di

import android.content.Context
import com.gradethread.app.sync.DeleteReconciler
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.RealtimeService
import com.gradethread.app.sync.SyncMerger
import com.gradethread.app.sync.SyncTrigger
import com.gradethread.app.sync.db.DatabaseProvider
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.github.jan.supabase.SupabaseClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Singleton

/**
 * US-1330: the Room graph. Singleton because [DatabaseProvider.open] runs the
 * corruption-recovery chain and publishes a one-time outcome — opening it
 * per-screen (as `CaptureScreen` does inline) would re-run that probe and can
 * hand different call sites different database instances after a RESET.
 */
@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): GradeThreadDb =
        DatabaseProvider.open(context)

    /**
     * One queue over that one database. It carries the create-before-edit
     * replay ordering, so a second instance could interleave two orderings.
     */
    @Provides
    @Singleton
    fun provideMutationQueue(db: GradeThreadDb): OfflineMutationQueue =
        OfflineMutationQueue(db)

    /**
     * US-2207: delete reconciliation, over that same one database.
     *
     * Singleton because the ~15-minute throttle lives in the instance. A
     * per-caller reconciler would carry a fresh `lastReconcileAt`, so every
     * trigger would run a full five-table id-scan and the throttle would be
     * decorative — which is a real cost on a large account, not just noise.
     *
     * Provided here rather than annotated with `@Inject` on the class so its
     * injectable clock default stays a plain constructor default for the tests.
     */
    @Provides
    @Singleton
    fun provideDeleteReconciler(db: GradeThreadDb): DeleteReconciler = DeleteReconciler(db)

    /** US-2367: the merge policy realtime events flow through. */
    @Provides
    @Singleton
    fun provideSyncMerger(db: GradeThreadDb): SyncMerger = SyncMerger(db)

    /**
     * US-2367: the live-inventory channel.
     *
     * Its own long-lived scope, not a screen's: a channel torn down because the
     * screen that happened to open it went away is a channel that stops
     * updating the moment someone navigates.
     *
     * The catch-up hook is the important argument. Postgres-change events
     * emitted while the socket was down are never replayed by the server, so
     * every transition INTO subscribed must pull (US-1211) or the gap is lost
     * until the next manual refresh.
     */
    @Provides
    @Singleton
    fun provideRealtimeService(
        client: SupabaseClient,
        merger: SyncMerger,
        syncTrigger: SyncTrigger,
    ): RealtimeService = RealtimeService(
        client = client,
        merger = merger,
        onCatchUpNeeded = { runCatching { syncTrigger.refresh(reason = "realtime_catchup") } },
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    )
}
