package com.gradethread.app.platform.di

import com.gradethread.app.analytics.CommunityInsightsProviding
import com.gradethread.app.analytics.CommunityInsightsService
import com.gradethread.app.analytics.ListingPerformanceProviding
import com.gradethread.app.analytics.ListingPerformanceService
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * US-1368: binds the listing-performance reader.
 *
 * An interface so the screen's behaviour — the denied-scope banner, the sort,
 * the no-views filter — is testable against a fake instead of a live eBay
 * connection with real traffic on it.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class AnalyticsModule {

    @Binds
    @Singleton
    abstract fun bindListingPerformance(
        impl: ListingPerformanceService,
    ): ListingPerformanceProviding

    @Binds
    @Singleton
    abstract fun bindCommunityInsights(
        impl: CommunityInsightsService,
    ): CommunityInsightsProviding
}
