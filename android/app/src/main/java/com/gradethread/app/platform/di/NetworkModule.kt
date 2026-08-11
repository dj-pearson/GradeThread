package com.gradethread.app.platform.di

import android.content.Context
import com.gradethread.app.capture.PhotoProfileStore
import com.gradethread.app.platform.AppConfig
import com.gradethread.app.platform.net.EdgeApi
import com.gradethread.app.platform.net.EdgeNetwork
import com.gradethread.app.platform.supabase.SupabaseShared
import com.gradethread.app.platform.supabase.edgeTokenProvider
import com.gradethread.app.platform.supabase.edgeTokenRefresher
import com.gradethread.app.platform.workspace.WorkspaceScope
import com.gradethread.app.ui.components.StoragePathResolver
import com.gradethread.app.upload.PhotoSignedUrlProvider
import com.gradethread.app.upload.SignedUrlStorageResolver
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
 * so the US-1523 transient-vs-signed-out contract holds everywhere; the
 * workspace scope (US-1309) supplies the X-Workspace-Owner header and absorbs
 * mid-session revocations.
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
        workspaceOwnerProvider = { WorkspaceScope.activeOwnerId },
        onWorkspaceRevoked = WorkspaceScope::handleAccessRevoked,
    )

    /**
     * US-1329: one process-wide signed-URL cache. Singleton because the cache
     * is the point — a per-screen instance would re-mint on every navigation,
     * and `clearCache()` on sign-out has to reach every cached URL.
     */
    @Provides
    @Singleton
    fun providePhotoSignedUrlProvider(client: SupabaseClient): PhotoSignedUrlProvider =
        PhotoSignedUrlProvider(
            supabaseUrl = AppConfig.supabaseUrl,
            anonKey = AppConfig.supabaseAnonKey,
            tokenProvider = client.edgeTokenProvider(),
        )

    /**
     * US-2469: one process-wide photo-profile table.
     *
     * Singleton for the same reason as the signed-URL cache: the whole point is
     * that the fetch happens once. A per-screen instance would re-fetch on
     * every navigation and, worse, a screen that failed the fetch would sit on
     * the bundled fallback while the one next to it showed the real table.
     */
    @Provides
    @Singleton
    fun providePhotoProfileStore(@Named("shared") api: EdgeApi): PhotoProfileStore =
        PhotoProfileStore(api)

    @Provides
    @Singleton
    fun provideStoragePathResolver(
        provider: PhotoSignedUrlProvider,
    ): StoragePathResolver = SignedUrlStorageResolver(provider)

    @Provides
    @Singleton
    @Named("ai")
    fun provideAiEdgeApi(client: SupabaseClient): EdgeApi = EdgeApi(
        baseUrl = AppConfig.edgeApiUrl,
        client = EdgeNetwork.aiClient(),
        tokenProvider = client.edgeTokenProvider(),
        tokenRefresher = client.edgeTokenRefresher(),
        workspaceOwnerProvider = { WorkspaceScope.activeOwnerId },
        onWorkspaceRevoked = WorkspaceScope::handleAccessRevoked,
    )
}
