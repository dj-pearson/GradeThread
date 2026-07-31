package com.gradethread.app.platform.di

import com.gradethread.app.analytics.CommunityInsightsProviding
import com.gradethread.app.analytics.CommunityInsightsService
import com.gradethread.app.analytics.ListingPerformanceProviding
import com.gradethread.app.analytics.ListingPerformanceService
import com.gradethread.app.consignment.ConsignorProviding
import com.gradethread.app.consignment.ConsignorService
import com.gradethread.app.feedback.FeedbackSending
import com.gradethread.app.feedback.FeedbackService
import com.gradethread.app.passport.PassportProviding
import com.gradethread.app.passport.PassportService
import com.gradethread.app.referrals.ReferralProviding
import com.gradethread.app.referrals.ReferralService
import com.gradethread.app.support.SupportProviding
import com.gradethread.app.support.SupportService
import com.gradethread.app.scout.ScoutScanning
import com.gradethread.app.scout.ScoutService
import com.gradethread.app.templates.TemplateProviding
import com.gradethread.app.templates.TemplateService
import com.gradethread.app.verified.VerifiedProviding
import com.gradethread.app.verified.VerifiedService
import com.gradethread.app.workspace.WorkspaceReading
import com.gradethread.app.workspace.WorkspaceRepository
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

    /** US-1372: consignor CRUD, RLS-scoped. */
    @Binds
    @Singleton
    abstract fun bindConsignors(impl: ConsignorService): ConsignorProviding

    /** US-1373: listing templates, RLS-scoped. */
    @Binds
    @Singleton
    abstract fun bindTemplates(impl: TemplateService): TemplateProviding

    /** US-1374: Scout + Prospect. */
    @Binds
    @Singleton
    abstract fun bindScout(impl: ScoutService): ScoutScanning

    /** US-1375: the verified-seller status read. */
    @Binds
    @Singleton
    abstract fun bindVerified(impl: VerifiedService): VerifiedProviding

    /** US-1376: the item passport chain. */
    @Binds
    @Singleton
    abstract fun bindPassport(impl: PassportService): PassportProviding

    /** US-1385: referral code, stats and redemption. */
    @Binds
    @Singleton
    abstract fun bindReferrals(impl: ReferralService): ReferralProviding

    /** US-1386: support tickets and their threads. */
    @Binds
    @Singleton
    abstract fun bindSupport(impl: SupportService): SupportProviding

    /** US-1387: one-way feedback. */
    @Binds
    @Singleton
    abstract fun bindFeedback(impl: FeedbackService): FeedbackSending

    /** US-1388: the workspaces this user can work inside. */
    @Binds
    @Singleton
    abstract fun bindWorkspaces(impl: WorkspaceRepository): WorkspaceReading
}
