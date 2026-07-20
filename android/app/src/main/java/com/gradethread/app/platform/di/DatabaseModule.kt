package com.gradethread.app.platform.di

import android.content.Context
import com.gradethread.app.sync.OfflineMutationQueue
import com.gradethread.app.sync.db.DatabaseProvider
import com.gradethread.app.sync.db.GradeThreadDb
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
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
}
