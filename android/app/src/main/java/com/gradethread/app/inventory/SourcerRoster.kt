package com.gradethread.app.inventory

import androidx.compose.runtime.Immutable
import com.gradethread.app.sync.db.SourcerEntity

/**
 * US-2886: the "Sourced by" roster, in a shape the Compose compiler can prove
 * stable.
 *
 * A bare `List<SourcerEntity>` parameter is NOT stable to Compose even though
 * the entity itself is, so a picker taking one can never skip recomposition.
 * Twenty-one composables in this app carry that as a baselined lint finding;
 * this one does not need to, because the wrapper is four lines and there is no
 * kotlinx-collections-immutable dependency to reach for instead. Data-class
 * equality does the comparing, so building one at the call site costs nothing.
 *
 * Its own file because detekt's MatchingDeclarationName wants the single
 * top-level class to match the filename.
 */
@Immutable
data class SourcerRoster(val entries: List<SourcerEntity>)
