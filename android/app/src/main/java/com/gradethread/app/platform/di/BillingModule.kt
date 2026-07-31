package com.gradethread.app.platform.di

import com.gradethread.app.billing.EdgePurchaseVerifier
import com.gradethread.app.billing.PlayBilling
import com.gradethread.app.billing.PurchaseVerifier
import com.gradethread.app.billing.RealPlayBilling
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * US-1366: binds the one real Play Billing implementation.
 *
 * A `@Binds` module rather than a direct injection so the interface is the type
 * the rest of the app depends on. That is what lets the purchase flow be
 * exercised against a fake instead of a device with a card in it.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class BillingModule {

    @Binds
    @Singleton
    abstract fun bindPlayBilling(impl: RealPlayBilling): PlayBilling

    @Binds
    @Singleton
    abstract fun bindPurchaseVerifier(impl: EdgePurchaseVerifier): PurchaseVerifier
}
