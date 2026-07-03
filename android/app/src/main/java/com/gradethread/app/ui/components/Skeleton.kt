package com.gradethread.app.ui.components

import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.gradethread.app.ui.theme.GradeThreadTheme

/**
 * US-1303: reduced-motion check — Android's "remove animations" accessibility
 * setting manifests as ANIMATOR_DURATION_SCALE == 0. The a11y foundation story
 * (US-1304) builds the full policy on top; skeletons need the read now so the
 * shimmer honors it (iOS SkeletonView honors Reduce Motion the same way).
 */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    }
}

/**
 * A shimmering placeholder block for skeleton loading states — a muted
 * rounded rect with a diagonal highlight sweep. With reduced motion on it's a
 * static muted fill. Always semantically hidden: skeletons are decorative.
 */
@Composable
fun SkeletonBlock(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 8.dp,
) {
    SkeletonShape(modifier, RoundedCornerShape(cornerRadius))
}

/** Circular shimmer placeholder (e.g. the grade-score ring). */
@Composable
fun SkeletonCircle(diameter: Dp, modifier: Modifier = Modifier) {
    SkeletonShape(modifier.size(diameter), CircleShape)
}

@Composable
private fun SkeletonShape(modifier: Modifier, shape: Shape) {
    val reduced = rememberReducedMotion()
    val base = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.12f)

    val sweep = if (reduced) {
        null
    } else {
        val transition = rememberInfiniteTransition(label = "skeleton")
        transition.animateFloat(
            initialValue = -1f,
            targetValue = 2f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1200, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "skeletonSweep",
        )
    }

    Spacer(
        modifier
            .clip(shape)
            .background(base)
            .drawWithContent {
                drawContent()
                val progress = sweep?.value ?: return@drawWithContent
                val bandWidth = size.width * 0.6f
                val x = progress * size.width
                drawRect(
                    brush = Brush.linearGradient(
                        colors = listOf(
                            Color.Transparent,
                            Color.White.copy(alpha = 0.45f),
                            Color.Transparent,
                        ),
                        start = Offset(x, 0f),
                        end = Offset(x + bandWidth, size.height),
                    ),
                )
            }
            .clearAndSetSemantics {},
    )
}

// A bare spacer that participates in layout (Compose's Spacer is in
// foundation.layout; re-declared thin here to keep the draw modifier local).
@Composable
private fun Spacer(modifier: Modifier) {
    androidx.compose.foundation.layout.Spacer(modifier)
}

@Preview(showBackground = true)
@Composable
private fun SkeletonPreview() {
    GradeThreadTheme {
        androidx.compose.foundation.layout.Column {
            SkeletonBlock(Modifier.size(width = 220.dp, height = 20.dp))
            SkeletonCircle(56.dp)
            SkeletonBlock(Modifier.fillMaxSize().size(height = 80.dp, width = 300.dp))
        }
    }
}
