package com.gradethread.app.platform.di

import android.content.Context
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeNetwork
import com.gradethread.app.platform.supabase.SupabaseShared
import com.gradethread.app.platform.supabase.edgeTokenProvider
import com.gradethread.app.platform.supabase.edgeTokenRefresher
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import io.github.jan.supabase.SupabaseClient
import javax.inject.Named
import javax.inject.Singleton

/**
 * US-1307: the networking graph — one Supabase client; two EdgeApi profiles
 * (iOS EdgeAPI.shared / EdgeAPI.aiShared) wired to the typed token providers
 * so the US-1523 transient-vs-signed-out contract holds everywhere. The
 * workspace-owner provider is a placeholder until the workspace-scope story
 * (US-1309) supplies the real source.
 */
@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun provideSupabaseClient(@ApplicationContext context: Context): SupabaseClient =
        SupabaseShared.client(context)

    @Provides
    @Singleton
    @Named("shared")
    fun provideEdgeApi(client: SupabaseClient): EdgeApi = EdgeApi(
        baseUrl = AppConfig.edgeApiUrl,
        client = EdgeNetwork.sharedClient(),
        tokenProvider = client.edgeTokenProvider(),
        tokenRefresher = client.edgeTokenRefresher(),
    )

    @Provides
    @Singleton
    @Named("ai")
    fun provideAiEdgeApi(client: SupabaseClient): EdgeApi = EdgeApi(
        baseUrl = AppConfig.edgeApiUrl,
        client = EdgeNetwork.aiClient(),
        tokenProvider = client.edgeTokenProvider(),
        tokenRefresher = client.edgeTokenRefresher(),
    )
}
